// The menu rule on its own (menuFit.test.ts): the bundle exposes it on window.
import * as menuFit from "../../src/menuFit";

(window as unknown as { __menuFit: typeof menuFit }).__menuFit = menuFit;
