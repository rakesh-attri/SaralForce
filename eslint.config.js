import globals from "globals";
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "addon/react.js", "addon/react-dom.js"]
  },
  {linterOptions: {reportUnusedDisableDirectives: "off"}},
  js.configs.recommended,
  {
    files: ["addon/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        React: "readonly",
        ReactDOM: "readonly",
        h: "readonly"
      }
    },
    plugins: {"react-hooks": reactHooks},
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off",
      "no-unused-vars": ["warn", {args: "none", caughtErrors: "none"}],
      "no-empty": ["warn", {allowEmptyCatch: true}],
      "no-prototype-builtins": "off",
      "no-useless-escape": "warn",
      "no-cond-assign": ["error", "except-parens"]
    }
  },
  {
    // Content script is a classic script, not a module.
    files: ["addon/button.js"],
    languageOptions: {sourceType: "script"}
  },
  {
    files: ["scripts/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {ecmaVersion: 2022, sourceType: "module", globals: {...globals.node}}
  },
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {ecmaVersion: 2022, sourceType: "commonjs", globals: {...globals.node}}
  }
];
