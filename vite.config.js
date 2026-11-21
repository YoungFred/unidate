import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  input: {
    main: fileURLToPath(new URL("./index.html", import.meta.url)),
    terms: fileURLToPath(new URL("./terms.html", import.meta.url)),
  },
});
