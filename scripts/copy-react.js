const fs = require("fs");
const path = require("path");

const addonDir = path.join(__dirname, "..", "addon");
const nodeModulesDir = path.join(__dirname, "..", "node_modules");

const files = [
  {src: path.join(nodeModulesDir, "react", "umd", "react.production.min.js"), dest: path.join(addonDir, "react.js")},
  {src: path.join(nodeModulesDir, "react-dom", "umd", "react-dom.production.min.js"), dest: path.join(addonDir, "react-dom.js")}
];

for (const file of files) {
  if (fs.existsSync(file.src)) {
    fs.copyFileSync(file.src, file.dest);
    console.log(`Copied ${path.basename(file.src)} -> ${path.basename(file.dest)}`);
  } else {
    console.error(`Source not found: ${file.src}`);
    console.error("Run 'npm install' first to install dependencies.");
    process.exit(1);
  }
}

console.log("React files copied successfully!");
