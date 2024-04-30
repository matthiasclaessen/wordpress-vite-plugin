# WordPress Vite Plugin

## Introduction

[Vite](https://vitejs.dev) is a modern frontend build tool that provides an extremely fast development environment and bundles your code for production.

This plugin configures Vite for use with a WordPress theme.

## Installing the WordPress Plugin

Run the following command in a terminal inside your project:

```shell
npm install -D wordpress-vite-plugin
```

## Configuring Vite

Vite is configured via a `vite.config.js` file in the root of your project, or in this case, your theme. You are free to customize this file based on your needs.

The WordPress Vite plugin requires you to specify the entry points for your application. These may be JavaScript of CSS files, and include preprocessed languages such as TypeScript, JSX, TSX and Sass.

```javascript
import { defineConfig } from 'vite';
import wordpress from 'wordpress-vite-plugin';

export default defineConfig({
  plugins: [wordpress(['src/scss/main.scss', 'src/js/main.js'])],
});
```

## Loading Your Scripts and Styles

Currently, this plugin requires you to create a file to make sure your assets are correctly enqueued. This means setting up logic for when you are serving your assets and when your building your assets.

Create a `vite.php` file in your `functions` folder and import it in your `functions.php` file, copy and paste the following code, or copy and paste the following code directly in your `functions.php` file:

```php
<?php

if (defined('IS_DEVELOPMENT') && IS_DEVELOPMENT) {
    add_action('wp_enqueue_scripts', 'vite_serve_assets');
} else {
    add_action('wp_enqueue_scripts', 'vite_build_assets');
}

function vite_serve_assets(): void
{
    $vite_server = file_exists(get_template_directory() . '/hot') ? file_get_contents(get_template_directory() . '/hot') : '';
    $entry_points = ['src/scss/main.scss', 'src/js/main.js'];

    // Add Vite client to <head> tag
    add_action('wp_head', function () use ($vite_server) {
        echo '<script type="module" src="' . $vite_server . '/@vite/client' . '"></script>';
    });

    foreach ($entry_points as $entry_point) {
        if (str_ends_with($entry_point, '.scss')) {
            add_action('wp_head', function () use ($vite_server, $entry_point) {
                echo '<link rel="stylesheet" type="text/css" href="' . $vite_server . '/' . $entry_point . '" />';
            });
        }

        if (str_ends_with($entry_point, '.js')) {
            add_action('wp_head', function () use ($vite_server, $entry_point) {
                echo '<script type="module" crossorigin src="' . $vite_server . '/' . $entry_point . '"></script>';
            });
        }
    }
}

function vite_build_assets(): void
{
    $manifest = json_decode(file_get_contents(get_template_directory() . '/build/manifest.json'), true);

    if (is_array($manifest)) {
        foreach ($manifest as $entry) {
            $file = $entry['file'];
            $path = get_template_directory_uri() . '/build/' . $file;

            if (str_ends_with($file, '.css')) {
                wp_enqueue_style('main', $path, [], false, false);
            }

            if (str_ends_with($file, '.js')) {
                wp_enqueue_script('main', $path, [], false, true);
            }
        }
    }
}
```

## Setting your environment

Lastly, in your `wp-config.php` file, add the following line of code as following:

```php
define( 'WP_DEBUG', false );

/* Add any custom values between this line and the "stop editing" line. */
define('IS_DEVELOPMENT', true);

/* That's all, stop editing! Happy publishing. */
```

Change this value to match your environment, i.e. 'production' or 'development'. The plugin will correctly enqueue the assets based on this setting.

## Running Vite

There are two ways you can run Vite. You may run the development server via the `dev` command, which is useful while developing locally. The development server will automatically detect changes to your files and instantly reflect them in any open browser windows.

Or, running the `build` command will version and bundle your application's assets and get them ready for you to deploy to production:

```shell
# Run the Vite development server
npm run dev

# Build and version the assets for production
npm run build
```

## Disclaimer

This plugin is heavily based on the 'laravel-vite-plugin'. Much of the code from this application is the same, except for a few modifications made specifically for WordPress projects.
