// electron-builder `afterPack` hook: give the macOS bundle an ad-hoc signature
// when no Developer ID is configured.
//
// With no certificate electron-builder skips signing altogether, and the app
// shipped with NO signature — not even the ad-hoc one every locally built
// Electron app carries. That is what turned a quarantined download into
// "GitStudio is damaged and can't be opened" on macOS 15+, a dialog with no
// way through. An ad-hoc-signed bundle gets the ordinary unidentified-developer
// prompt instead, and System Settings ▸ Privacy & Security then offers
// "Open Anyway". Same code, one signature, a door instead of a wall.
//
// electron-builder runs this after the .app is assembled and before it signs
// with a real identity, so when CSC_LINK / CSC_NAME are set the proper
// signature simply replaces this one. Homebrew, install.sh and the in-app
// updater are unaffected either way (none of them leaves the quarantine flag).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // a real identity will sign
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const run = (args) => execFileSync("codesign", args, { stdio: "inherit" });
  run(["--force", "--deep", "--sign", "-", "--timestamp=none", app]);
  run(["--verify", "--deep", "--strict", app]);
  console.log(`  • ad-hoc signed ${path.basename(app)} (no Developer ID configured)`);
};
