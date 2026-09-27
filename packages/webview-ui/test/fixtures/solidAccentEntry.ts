// Test entry: the solid-accent installer and the tokens it feeds, uninstalled
// (the test decides when, and how: the bundle's function or the inline source).
import "../../src/styles/tokens.css";
import { hostTokens } from "../../src/styles/hostTokens";
import { installSolidAccent, SOLID_ACCENT_JS } from "../../src/styles/solidAccent";

(window as unknown as { gsSolid: unknown }).gsSolid = { install: installSolidAccent, js: SOLID_ACCENT_JS, hostTokens };
