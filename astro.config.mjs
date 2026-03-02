// @ts-check
import { defineConfig } from "astro/config";
import pagefind from "astro-pagefind";
import sitemap from "@astrojs/sitemap";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypePhotoswipe from "./src/utils/rehype-photoswipe";
import { remarkPostBody } from "./src/utils/remark-post-body";
import expressiveCode from "astro-expressive-code";

const isProd = process.env.NODE_ENV === "production" || process.argv.includes("build");

// ✅ GitHub Pages 项目页： https://sonwwall.github.io/blog/
const SITE = isProd ? "https://sonwwall.github.io" : "http://localhost:4321";
const BASE = isProd ? "/blog" : "";

export default defineConfig({
  output: "static",
  site: SITE,
  base: BASE,

  experimental: { preserveScriptOrder: true },
  build: { concurrency: 10 },

  integrations: [
    pagefind(),
    sitemap({
      filter: (page) => {
        // page 是完整 URL（包含 site + base），所以这里用 includes 更稳
        return (
          page.includes("/posts/") ||
          page.includes("/about/") ||
          page.includes("/links/") ||
          page === `${SITE}${BASE}/` ||
          page === `${SITE}${BASE}/archives/` ||
          page === `${SITE}${BASE}/tags/` ||
          page === `${SITE}${BASE}/categories/` ||
          page.includes("/tags/") ||
          page.includes("/categories/")
        );
      },
      changefreq: "weekly",
      priority: 0.7,
      lastmod: new Date(),
    }),
    expressiveCode({
      themes: ["dark-plus", "github-light"],
      styleOverrides: {
        borderRadius: "0.5rem",
        frames: { shadowColor: "#124" },
      },
      useDarkModeMediaQuery: true,
      minSyntaxHighlightingColorContrast: 5.5,
      defaultProps: {
        wrap: true,
        overridesByLang: { "bash,ps,sh": { preserveIndent: false } },
      },
    }),
  ],

  vite: {
    define: {
      __VUE_OPTIONS_API__: true,
      __VUE_PROD_DEVTOOLS__: false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    },
    build: {
      cssMinify: "lightningcss",
      target: "es2022",
      sourcemap: false,
    },
  },

  markdown: {
    remarkPlugins: [remarkPostBody, remarkMath],
    rehypePlugins: [[rehypeKatex, { strict: false }], rehypePhotoswipe],
    smartypants: true,
    gfm: true,
  },
});