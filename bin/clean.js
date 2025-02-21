#!/usr/bin/env node

// Import required Node.js file system and path functions
import { readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { dirname } from "path";

/**
 * Helper to retrieve a command-line argument with the format --name=value.
 * Returns the value if found, otherwise undefined.
 */
const argument = (name) => {
  const index = process.argv.findIndex((argument) =>
    argument.startsWith(`--${name}=`)
  );
  return index === -1
    ? undefined
    : process.argv[index].substring(`--${name}=`.length);
};

/**
 * Helper to check if a command-line flag (e.g., --quiet) is present.
 */
const option = (name) => process.argv.includes(`--${name}`);

/**
 * Logging helpers:
 * - 'info' and 'error' log messages unless the --quiet flag is provided.
 */
const info = option(`quiet`) ? () => undefined : console.log;
const error = option(`quiet`) ? () => undefined : console.error;

/**
 * Main function to clean up orphaned asset files.
 */
const main = () => {
  // Determine the manifest file path(s) based on command-line arguments:
  // - If --manifest is provided, use that file.
  // - If --ssr flag is set, try two SSR manifest paths.
  // - Otherwise, default to the non-SSR manifest.
  const manifestPaths = argument(`manifest`)
    ? [argument(`manifest`)]
    : option(`ssr`)
    ? [`./bootstrap/ssr/ssr-manifest.json`, `./bootstrap/ssr/manifest.json`]
    : [`./public/build/manifest.json`];

  // Find the first manifest file that exists on disk.
  const foundManifestPath = manifestPaths.find(existsSync);

  // Exit with an error message if no manifest file is found.
  if (!foundManifestPath) {
    error(`Unable to find manifest file.`);
    process.exit(1);
  }

  info(`Reading manifest [${foundManifestPath}].`);

  // Read and parse the manifest JSON file.
  const manifest = JSON.parse(readFileSync(foundManifestPath).toString());

  // Get all keys from the manifest (each key represents an asset entry).
  const manifestFiles = Object.keys(manifest);

  // Determine if the manifest is in SSR format (values are arrays) or non-SSR (objects with file/css properties).
  const isSsr = Array.isArray(manifest[manifestFiles[0]]);
  isSsr ? info(`SSR manifest found.`) : info(`Non-SSR manifest found.`);

  // Extract asset paths:
  // - For SSR, flatten all arrays from each manifest key.
  // - For non-SSR, combine any CSS files with the main file.
  const manifestAssets = isSsr
    ? manifestFiles.flatMap((key) => manifest[key])
    : manifestFiles.flatMap((key) => [
        ...(manifest[key].css ?? []),
        manifest[key].file,
      ]);

  // Determine the assets directory:
  // - Use the --assets argument if provided.
  // - Otherwise, use the directory of the manifest file with '/assets' appended.
  const assetsPath =
    argument("assets") ?? dirname(foundManifestPath) + "/assets";

  info(`Verify assets in [${assetsPath}]`);

  // Read all entries (files and directories) in the assets folder.
  const existingAssets = readdirSync(assetsPath, { withFileTypes: true });

  // Filter the list to identify orphaned assets:
  // - Only consider files.
  // - A file is orphaned if it is not referenced in the manifest.
  const orphanedAssets = existingAssets
    .filter((file) => file.isFile())
    .filter(
      (file) =>
        manifestAssets.findIndex((asset) => asset.endsWith(`/${file.name}`)) ===
        -1
    );

  // Log the result and either simulate or execute deletion based on the --dry-run flag.
  if (orphanedAssets.length === 0) {
    info("No orphaned assets found.");
  } else {
    orphanedAssets.length === 1
      ? info(`[${orphanedAssets.length}] orphaned asset found.`)
      : info(`[${orphanedAssets.length}] orphaned assets found.`);

    orphanedAssets.forEach((asset) => {
      // Construct the full path to the orphaned asset.
      // NOTE: There is an extra '}' at the end of the path; it likely should be removed.
      const path = `${assetsPath}/${asset.name}}`;
      // If --dry-run is set, only log what would be removed; otherwise, delete the file.
      if (option("dry-run")) {
        info(`Orphaned asset [${path}] would be removed.`);
      } else {
        info(`Removing orphaned asset [${path}].`);
        unlinkSync(path);
      }
    });
  }
};

main();
