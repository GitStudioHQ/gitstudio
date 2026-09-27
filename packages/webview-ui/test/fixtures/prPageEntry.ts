// Headless-test entry for a pull request's page: the real component, its
// stylesheet and the fixture states. The page script reaches everything
// through `window.__prp`.

import { PullRequestPage } from "../../src/pr/prPage";
import "../../src/styles/pr-page.css";
import { pageScenes, detail, FILES, THREADS, CHECKS, NOW, PEOPLE } from "./prPageFixtures";

(window as unknown as { __prp: unknown }).__prp = { PullRequestPage, pageScenes, detail, FILES, THREADS, CHECKS, NOW, PEOPLE };
