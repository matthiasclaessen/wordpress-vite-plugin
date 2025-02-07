import fs from "fs";
import { AddressInfo } from "net";
import os from "os";
import { fileURLToPath } from "url";
import path from "path";
import colors from "picocolors";
import {
  Plugin,
  loadEnv,
  UserConfig,
  ConfigEnv,
  ResolvedConfig,
  PluginOption,
} from "vite";
import fullReload, {
  Config as FullReloadConfig,
} from "vite-plugin-full-reload";

// ============================================================
// Plugin Configuration Interfaces
// ============================================================

interface PluginConfig {
  /**
   * The path or paths of the entry points to compile.
   */
  input: string | string[];

  /**
   * The temporary directory used for the "hot" file.
   *
   * @default 'temp'
   */
  tempDirectory?: string;

  /**
   * The subdirectory where compiled assets should be written.
   *
   * @default 'build'
   */
  buildDirectory?: string;

  /**
   * The file used for hot module replacement.
   *
   * @default `${tempDirectory}/hot`
   */
  hotFile?: string;

  // The path to the 'vite.settings.json' file.
  settingsFile?: string;

  // The path of the SSR entry point.
  ssr?: string | string[];

  // The directory where the SSR bundle should be written.
  ssrOutputDirectory?: string;

  // Configuration for performing full page refresh on PHP (or other) file changes.
  refresh?: boolean | string | string[] | RefreshConfig | RefreshConfig[];

  // Utilise the Herd of Valet TLS certificates.
  detectTls?: string | boolean | null;

  // Allow explicit selection of the local development environment.
  devEnvironment?: "herd" | "valet" | "xampp" | "auto" | false;

  // Callback to transform the code while serving.
  transformOnServe?: (code: string, url: DevServerUrl) => string;
}

interface RefreshConfig {
  paths: string[];
  config?: FullReloadConfig;
}

// Extending the Vite Plugin interface with our custom config method.
interface WordPressPlugin extends Plugin {
  config: (config: UserConfig, env: ConfigEnv) => UserConfig;
}

type DevServerUrl = `${"http" | "https"}://${string}:${number}`;

// Flag to ensure that exit handlers are only bound once.
let exitHandlersBound = false;

// ============================================================
// Default refresh paths – checks if the base directories exist.
// The filter removes any glob pattern that, when trimmed, does not exist.
export const refreshPaths = [
  "*.php",
  "templates/**/*.php",
  "functions/*.php",
].filter((path) => fs.existsSync(path.replace(/\*\*$/, "")));

// ============================================================
// Main Plugin Function
// This function accepts either a string, array of strings, or a full PluginConfig.
// It returns an array of Vite plugins – the core WordPress plugin plus any full reload plugins.
export default function wordpress(
  config: string | string[] | PluginConfig
): [WordPressPlugin, ...Plugin[]] {
  // Normalize the configuration by merging with defaults.
  const pluginConfig = resolvePluginConfig(config);

  return [
    resolveWordPressPlugin(pluginConfig),
    ...(resolveFullReloadConfig(pluginConfig) as Plugin[]),
  ];
}

// ============================================================
// Core WordPress Vite Plugin Definition
// This plugin configures Vite for a WordPress environment.
function resolveWordPressPlugin(
  pluginConfig: Required<PluginConfig>
): WordPressPlugin {
  // These variables will be used later in the plugin lifecycle.
  let viteDevServerUrl: DevServerUrl;
  let resolvedConfig: ResolvedConfig;
  let userConfig: UserConfig;

  // Default aliases for module resolution (e.g., "@" maps to "/src").
  const defaultAliases: Record<string, string> = {
    "@": "/src",
  };

  return {
    name: "wordpress",
    enforce: "post", // Ensures this plugin runs after others have been applied.
    config: (config, { command, mode }) => {
      // The config hook merges the user-provided Vite configuration with our defaults.
      userConfig = config;
      const ssr = !!userConfig.build?.ssr; // Determine if SSR is enabled.
      const env = loadEnv(mode, userConfig.envDir || process.cwd(), ""); // Load environment variables from the .env files.
      const assetUrl = env.ASSET_URL ?? "";
      // For the development server, resolve TLS/HTTPS config from Herd/Valet or environment.
      const serverConfig =
        command === "serve"
          ? resolveDevelopmentEnvironmentServerConfig(
              pluginConfig.detectTls,
              pluginConfig.devEnvironment
            ) ?? resolveEnvironmentServerConfig(env)
          : undefined;

      // Ensure that running in serve mode is allowed (e.g. not in CI).
      ensureCommandShouldRunInEnvironment(command, env);

      return {
        // Set the base path for assets.
        base:
          userConfig.base ??
          (command === "build" ? resolveBase(pluginConfig, assetUrl) : ""),
        build: {
          // Configure manifest generation. For SSR, disable manifest if needed.
          manifest:
            userConfig.build?.manifest ?? (ssr ? false : "manifest.json"),
          ssrManifest:
            userConfig.build?.ssrManifest ??
            (ssr ? "ssr-manifest.json" : false),
          // Set the output directory.
          outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig, ssr),
          rollupOptions: {
            // Determine the entry point(s) for Rollup.
            input:
              userConfig.build?.rollupOptions?.input ??
              resolveInput(pluginConfig, ssr),
            // Note: The output configuration is left for user override.
          },
          // Set the inline asset limit to 0 to disable asset inlining.
          assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
        },
        server: {
          // Use a placeholder that will be replaced in the transform hook.
          origin: userConfig.server?.origin ?? "__wordpress_vite_placeholder__",
          ...(serverConfig
            ? {
                host: userConfig.server?.host ?? serverConfig.host,
                hmr:
                  userConfig.server?.hmr === false
                    ? false
                    : {
                        ...serverConfig.hmr,
                        ...(userConfig.server?.hmr === true
                          ? {}
                          : userConfig.server?.hmr),
                      },
                https: userConfig.server?.https ?? serverConfig.https,
              }
            : undefined),
        },
        resolve: {
          // Merge default aliases with user-defined ones.
          alias: Array.isArray(userConfig.resolve?.alias)
            ? [
                ...(userConfig.resolve.alias ?? []),
                ...Object.keys(defaultAliases).map((alias) => ({
                  find: alias,
                  replacement: defaultAliases[alias],
                })),
              ]
            : {
                ...defaultAliases,
                ...userConfig.resolve?.alias,
              },
        },
      };
    },

    // Store the resolved configuration for later use.
    configResolved(config) {
      resolvedConfig = config;
    },

    // The transform hook is used to update the served code in development.
    transform(code) {
      if (resolvedConfig.command === "serve") {
        // Replace the placeholder with the actual dev server URL.
        code = code.replace(
          /__wordpress_vite_placeholder__/g,
          viteDevServerUrl
        );
        // Optionally transform the code further via user callback.
        return pluginConfig.transformOnServe(code, viteDevServerUrl);
      }
    },

    // The configureServer hook sets up HMR and additional middleware.
    configureServer(server) {
      // Read settings from the provided settings file (e.g., vite.settings.json).
      const settings = JSON.parse(
        fs.readFileSync(pluginConfig.settingsFile, "utf8")
      );
      const appUrl = settings.app_url;

      // Once the HTTP server is listening, set up the dev server URL and write the hot file.
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();

        // Helper type guard to ensure address is of type AddressInfo.
        const isAddressInfo = (
          x: string | AddressInfo | null | undefined
        ): x is AddressInfo => typeof x === "object";

        if (isAddressInfo(address)) {
          viteDevServerUrl = userConfig.server?.origin
            ? (userConfig.server.origin as DevServerUrl)
            : resolveDevServerUrl(address, server.config, userConfig);
          // Write the resolved dev server URL to the hot file.
          fs.writeFileSync(pluginConfig.hotFile, viteDevServerUrl);

          // Delay logging to ensure that everything is initialized.
          setTimeout(() => {
            server.config.logger.info(
              `\n ${colors.dim("plugin")} ${colors.bold(`v${pluginVersion()}`)}`
            );
            server.config.logger.info("");
            server.config.logger.info(
              `  ${colors.green("➜")}  ${colors.bold("APP_URL")}: ${colors.cyan(
                appUrl.replace(
                  /:(\d+)/,
                  (_: string, port: string) => `:${colors.bold(port)}`
                )
              )}\n`
            );

            // Special log message if using a Herd certificate.
            if (
              typeof resolvedConfig.server.https === "object" &&
              typeof resolvedConfig.server.https.key === "string"
            ) {
              if (resolvedConfig.server.https.key.startsWith("Herd")) {
                server.config.logger.info(
                  `  ${colors.green(
                    "➜"
                  )}  Using Herd certificate to secure Vite.`
                );
              }
            }
          }, 100);
        }
      });

      // Ensure that cleanup handlers are registered only once.
      if (!exitHandlersBound) {
        const clean = () => {
          if (fs.existsSync(pluginConfig.hotFile)) {
            fs.rmSync(pluginConfig.hotFile);
          }
        };

        process.on("exit", clean);
        process.on("SIGINT", () => process.exit());
        process.on("SIGTERM", () => process.exit());
        process.on("SIGHUP", () => process.exit());

        exitHandlersBound = true;
      }

      // Add middleware to handle requests for "/index.html".
      return () =>
        server.middlewares.use((request, response, next) => {
          if (request.url === "/index.html") {
            response.statusCode = 404;
            // Serve a custom dev server index HTML file with APP_URL injected.
            response.end(
              fs
                .readFileSync(path.join(dirname(), "dev-server-index.html"))
                .toString()
                .replace(/{{ APP_URL }}/g, appUrl)
            );
          }
          next();
        });
    },
  };
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Ensure that the serve command is not run in disallowed environments.
 * For example, prevent running the dev server in CI environments.
 */
function ensureCommandShouldRunInEnvironment(
  command: "build" | "serve",
  env: Record<string, string>
): void {
  if (command === "build") {
    return;
  }

  // TODO: Implement additional checks to verify that a WordPress environment is present.

  if (typeof env.CI !== "undefined") {
    throw Error(
      "You should not run the Vite HMR server in CI environments. You should build your assets for production instead. To disable this ENV check you may set LARAVEL_BYPASS_ENV_CHECK=1"
    );
  }
}

/**
 * Retrieve the plugin version by reading package.json.
 * If the file cannot be read, return an empty string.
 */
function pluginVersion(): string {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dirname(), "../package.json")).toString()
    )?.version;
  } catch {
    return "";
  }
}

/**
 * Normalize the user configuration and apply default values.
 * This function also validates required properties (e.g., 'input').
 */
function resolvePluginConfig(
  config: string | string[] | PluginConfig
): Required<PluginConfig> {
  if (typeof config === "undefined") {
    throw new Error("wordpress-vite-plugin: missing configuration");
  }

  // If a string or an array is passed, assume it's the input for both normal and SSR.
  if (typeof config === "string" || Array.isArray(config)) {
    config = { input: config, ssr: config };
  }

  if (typeof config.input === "undefined") {
    throw new Error(
      'wordpress-vite-plugin: missing configuration for "input".'
    );
  }

  // Clean up and validate directory paths.
  if (typeof config.tempDirectory === "string") {
    config.tempDirectory = config.tempDirectory.trim().replace(/^\/+/, "");

    if (config.tempDirectory === "") {
      throw new Error(
        "wordpress-vite-plugin: tempDirectory must be a subdirectory. E.g. 'temp'."
      );
    }
  }

  if (typeof config.buildDirectory === "string") {
    config.buildDirectory = config.buildDirectory
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    if (config.buildDirectory === "") {
      throw new Error(
        "wordpress-vite-plugin: buildDirectory must be a subdirectory. E.g. 'build'."
      );
    }
  }

  if (typeof config.ssrOutputDirectory === "string") {
    config.ssrOutputDirectory = config.ssrOutputDirectory
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  // If refresh is enabled as a boolean, convert to default refresh configuration.
  if (config.refresh === true) {
    config.refresh = [{ paths: refreshPaths }];
  }

  return {
    input: config.input,
    tempDirectory: config.tempDirectory ?? "temp",
    buildDirectory: config.buildDirectory ?? "build",
    ssr: config.ssr ?? config.input,
    ssrOutputDirectory: config.ssrOutputDirectory ?? "bootstrap/ssr",
    refresh: config.refresh ?? false,
    hotFile: config.hotFile ?? "hot",
    settingsFile: config.settingsFile ?? "vite.settings.json",
    detectTls: config.detectTls ?? null,
    devEnvironment: config.devEnvironment ?? "auto",
    transformOnServe: config.transformOnServe ?? ((code) => code),
  };
}

/**
 * Construct the base path for production assets.
 */
function resolveBase(config: Required<PluginConfig>, assetUrl: string): string {
  return (
    assetUrl +
    (!assetUrl.endsWith("/") ? "/" : "") +
    config.buildDirectory +
    "/"
  );
}

/**
 * Determine the entry point(s) for the Rollup build.
 * If SSR is enabled, use the SSR entry points; otherwise, use the standard input.
 */
function resolveInput(
  config: Required<PluginConfig>,
  ssr: boolean
): string | string[] | undefined {
  if (ssr) {
    return config.ssr;
  }
  return config.input;
}

/**
 * Determine the output directory for the build.
 * Use the SSR output directory if in SSR mode.
 */
function resolveOutDir(
  config: Required<PluginConfig>,
  ssr: boolean
): string | undefined {
  if (ssr) {
    return config.ssrOutputDirectory;
  }
  return path.join(config.buildDirectory);
}

/**
 * Convert refresh configuration to full-reload Vite plugins.
 * Allows the user to specify paths that should trigger a full page reload.
 */
function resolveFullReloadConfig({
  refresh: config,
}: Required<PluginConfig>): PluginOption[] {
  if (typeof config === "boolean") {
    return [];
  }

  if (typeof config === "string") {
    config = [{ paths: [config] }];
  }

  if (!Array.isArray(config)) {
    config = [config];
  }

  if (config.some((c) => typeof c === "string")) {
    config = [{ paths: config }] as RefreshConfig[];
  }

  return (config as RefreshConfig[]).flatMap((c) => {
    const plugin = fullReload(c.paths, c.config);

    /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
    /** @ts-ignore */
    plugin.__wordpress_plugin_config = c;

    return plugin;
  });
}

/**
 * Given the server's address and configuration, build the dev server URL.
 * The URL is determined based on protocol, host, and port from the HMR settings.
 */
function resolveDevServerUrl(
  address: AddressInfo,
  config: ResolvedConfig,
  userConfig: UserConfig
): DevServerUrl {
  const configHMRProtocol =
    typeof config.server.hmr === "object" ? config.server.hmr.protocol : null;
  const clientProtocol = configHMRProtocol
    ? configHMRProtocol === "wss"
      ? "https"
      : "http"
    : null;
  const serverProtocol = config.server.https ? "https" : "http";
  const protocol = clientProtocol ?? serverProtocol;

  const configHMRHost =
    typeof config.server.hmr === "object" ? config.server.hmr.host : null;
  const configHost =
    typeof config.server.host === "string" ? config.server.host : null;
  const sailHost =
    process.env.LARAVEL_SAIL && !userConfig.server?.host ? "localhost" : null;
  // If the address is IPv6, wrap it in brackets.
  const serverAddress = isIpv6(address)
    ? `[${address.address}]`
    : address.address;
  const host = configHMRHost ?? sailHost ?? configHost ?? serverAddress;

  const configHMRClientPort =
    typeof config.server.hmr === "object" ? config.server.hmr.clientPort : null;
  const port = configHMRClientPort ?? address.port;

  return `${protocol}://${host}:${port}`;
}

/**
 * Helper function to detect if an address is IPv6.
 */
function isIpv6(address: AddressInfo): boolean {
  return (
    address.family === "IPv6" ||
    // For Node versions where the family might be numeric.
    // @ts-expect-error: Expected a number, not string.
    address.family === 6
  );
}

/**
 * Attempt to build an HTTPS configuration from environment variables.
 * Looks for VITE_DEV_SERVER_KEY and VITE_DEV_SERVER_CERT and validates their existence.
 */
function resolveEnvironmentServerConfig(env: Record<string, string>):
  | {
      hmr?: { host: string };
      host?: string;
      https?: { cert: Buffer; key: Buffer };
    }
  | undefined {
  if (!env.VITE_DEV_SERVER_KEY && !env.VITE_DEV_SERVER_CERT) {
    return;
  }

  if (
    !fs.existsSync(env.VITE_DEV_SERVER_KEY) ||
    !fs.existsSync(env.VITE_DEV_SERVER_CERT)
  ) {
    throw Error(
      `Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`
    );
  }

  const host = resolveHostFromEnv(env);

  if (!host) {
    throw Error(
      `Unable to determine the host from the environment's APP_URL: [${env.APP_URL}]`
    );
  }

  return {
    hmr: { host },
    host,
    https: {
      key: fs.readFileSync(env.VITE_DEV_SERVER_KEY),
      cert: fs.readFileSync(env.VITE_DEV_SERVER_CERT),
    },
  };
}

/**
 * Parse the APP_URL from the environment to extract the host.
 */
function resolveHostFromEnv(env: Record<string, string>): string | undefined {
  try {
    return new URL(env.APP_URL).host;
  } catch {
    return;
  }
}

/**
 * Determine the HTTPS configuration for development environments using Herd or Valet.
 * This will look up certificates based on a configuration directory.
 */
function resolveDevelopmentEnvironmentServerConfig(
  host: string | boolean | null,
  devEnvironment: "herd" | "valet" | "xampp" | "docker" | "auto" | false
):
  | {
      hmr?: { host: string };
      host?: string;
      https?: {
        key: Buffer;
        cert: Buffer;
        certificateProvider: "herd" | "valet" | "xampp" | "docker";
      };
    }
  | undefined {
  // If TLS is disabled or explicitly turned off via devEnvironment, return undefined.
  if (host === false || devEnvironment === false) {
    return undefined;
  }

  // If auto-detect is enabled, try to determine the environment.
  if (devEnvironment === "auto") {
    if (fs.existsSync(herdConfigPath())) {
      devEnvironment = "herd";
    } else if (process.platform === "darwin") {
      // On macOS, if Herd isn’t available, assume Valet.
      devEnvironment = "valet";
    } else {
      // Otherwise, no TLS configuration is available.
      return undefined;
    }
  }

  let configPath: string | undefined;
  let provider: "herd" | "valet" | "xampp" | "docker" | undefined;

  switch (devEnvironment) {
    case "herd":
      configPath = herdConfigPath();
      provider = "herd";
      break;
    case "valet":
      configPath = valetConfigPath();
      provider = "valet";
      break;
    case "xampp":
      configPath = xamppConfigPath();
      provider = "xampp";
      break;
    case "docker":
      configPath = dockerConfigPath();
      provider = "docker";
      break;
    default:
      configPath = undefined;
      provider = undefined;
  }

  if (!configPath || !provider) {
    console.warn(
      `Unable to locate the configuration directory for environment: ${devEnvironment}. Falling back to insecure HTTP.`
    );

    return undefined;
  }

  // Determine the resolved host name for certificate lookup.
  const resolvedHost =
    host === true || host === null ? getWordPressRootFolderName() : host;

  console.log("Resolved host:", resolvedHost);

  // For Docker we assume certificates are directly in the configPath;
  // for other environments they are typically in a "Certificates" subdirectory.
  const certsDirectory =
    devEnvironment === "docker"
      ? configPath
      : path.resolve(configPath, "Certificates");

  // Construct the paths to the certificate files.
  const keyPath = path.resolve(certsDirectory, `${resolvedHost}.key`);
  const certPath = path.resolve(certsDirectory, `${resolvedHost}.crt`);

  // If certificate files exist, use them; otherwise, log a warning and fall back.
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      hmr: { host: resolvedHost },
      host: resolvedHost,
      https: {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        certificateProvider: provider,
      },
    };
  } else {
    console.warn(
      `Certificate files for host [${resolvedHost}] not found in [${certsDirectory}]. Falling back to insecure HTTP.`
    );
    return undefined;
  }
}

/**
 * Helper function to get the directory of the current file.
 */
function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}

/**
 * Returns the Herd configuration directory path.
 * Adjust if the configuration directory for your environment differs.
 */
function herdConfigPath(): string {
  console.log(
    path.resolve(
      os.homedir(),
      "Library",
      "Application Support",
      "Herd",
      "config",
      "valet"
    )
  );
  return path.resolve(
    os.homedir(),
    "Library",
    "Application Support",
    "Herd",
    "config",
    "valet"
  );
}

// Locate the Laravel Valet configuration directory.
// On many systems, Valet certificates are stored in ~/.config/valet/Certificates.
function valetConfigPath(): string {
  const possiblePaths = [
    path.resolve(os.homedir(), ".config", "valet", "Certificates"),
    path.resolve(os.homedir(), ".valet", "Certificates"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error("Unable to locate the Valet certificates directory.");
}

// Locate a potential XAMPP SSL certificate directory.
// This is a best‑guess approach and may require adjustments.
function xamppConfigPath(): string {
  const possiblePaths = [
    "/opt/lampp/etc/ssl", // common on Linux XAMPP installations
    path.resolve(os.homedir(), "xampp", "apache", "conf", "ssl"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error("Unable to locate the XAMPP SSL certificates directory.");
}

function dockerConfigPath(): string {
  if (
    process.env.DOCKER_CERT_PATH &&
    fs.existsSync(process.env.DOCKER_CERT_PATH)
  ) {
    return process.env.DOCKER_CERT_PATH;
  }

  const possiblePaths = ["/etc/ssl/docker", "/certs", "/run/secrets"];

  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      return path;
    }
  }
  throw new Error("Unable to locate the Docker SSL certificates directory.");
}

/**
 * Read the TLD from the development environment configuration.
 */
// function resolveDevelopmentEnvironmentTld(configPath: string): string {
//   const configFile = path.resolve(configPath, "config.json");

//   if (!fs.existsSync(configFile)) {
//     throw new Error(`Unable to find the configuration file [${configFile}].`);
//   }

//   const config: { tld: string } = JSON.parse(
//     fs.readFileSync(configFile, "utf-8")
//   );

//   return config.tld;
// }

/**
 * Walk upward from the current working directory until a file named "wp-config.php" is found.
 * Return the basename of the directory that contains it.
 * If not found, fall back to the current working directory's basename.
 */
function getWordPressRootFolderName(): string {
  let dir = process.cwd();
  /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
  while (true) {
    if (fs.existsSync(path.join(dir, "wp-config.php"))) {
      return path.basename(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root; give up.
      break;
    }
    dir = parent;
  }
  // Fallback to process.cwd() if no wp-config.php is found.
  return path.basename(process.cwd());
}
