import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  // Svelte 5.56.x's built-in TS stripping leaves the optional `?` marker on
  // function parameters (e.g. `function log(text, status?)`), producing invalid
  // JS that fails the rolldown build. `script: true` routes TS stripping through
  // Vite's oxc transformer instead, which handles optional params correctly.
  // See the sveltejs/svelte regression in 5.56.3.
  preprocess: vitePreprocess({ script: true }),
}
