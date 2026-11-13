import { defineConfig, globalIgnores } from "eslint/config";
import hooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  ...tseslint.configs.recommended,
  { files: ["src/**/*.tsx"], ...hooks.configs.flat.recommended },
  globalIgnores([".next/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
);
