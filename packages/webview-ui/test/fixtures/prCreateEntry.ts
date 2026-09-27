// Headless-test entry for a new pull request's form: the real component, its
// stylesheet and the fixture states. The page script reaches everything
// through `window.__prc`.

import { PullRequestCreate } from "../../src/pr/prCreate";
import "../../src/styles/pr-create.css";
import { createScenes, createState, COMMITS, FILES, TEMPLATE, NOW, PEOPLE } from "./prCreateFixtures";

(window as unknown as { __prc: unknown }).__prc = { PullRequestCreate, createScenes, createState, COMMITS, FILES, TEMPLATE, NOW, PEOPLE };
