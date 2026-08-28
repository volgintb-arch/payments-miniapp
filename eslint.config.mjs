import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Вендорённая копия Telegram Web App SDK — чужой код, не наш стиль.
    // Обновляется целиком: curl -o public/telegram-web-app.js \
    //   https://telegram.org/js/telegram-web-app.js
    "public/telegram-web-app.js",
  ]),
]);

export default eslintConfig;
