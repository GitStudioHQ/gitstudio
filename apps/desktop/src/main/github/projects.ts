// Projects v2 (the GitHub "Projects" board) for the desktop app's GitHub section.
//
// Projects v2 has NO REST API — everything here goes through the client's
// `graphql<T>()` primitive, which already throws (via toError) on HTTP failure
// AND on `json.errors[0].message`. So the READ functions carry NO local
// try/catch: scope / rate-limit / network errors propagate to the renderer's
// errorState (the throw-on-read convention). The MUTATIONS stay wrapped and
// return a CommitActionResult-shaped object ({ ok, changed, message }).
//
// Repo-scoped reads take (client, owner, repo); the board read + the two
// mutations act on opaque GraphQL node ids, so they take (client, …ids). main.ts
// drives all of them through `github.withRepo((c, o, r) => …)`, which already
// guards the not-connected / not-on-github.com cases before we are reached.

import { GitHubClient } from "../githubClient";
import type { CommitActionResult, ProjectBoard, ProjectInfo } from "../../shared/ipc";

// ── Raw GraphQL shapes (this module owns its own Raw* interfaces + mappers) ────

interface RawProjectsData {
  repository?: {
    projectsV2?: {
      nodes?: ({
        id: string;
        number: number;
        title: string;
        shortDescription?: string | null;
        url: string;
        closed: boolean;
        updatedAt?: string | null;
        items?: { totalCount: number } | null;
      } | null)[];
    } | null;
  } | null;
}

interface RawBoardField {
  id: string;
  name: string;
  options?: ({ id: string; name: string; color?: string | null } | null)[] | null;
}

interface RawBoardContent {
  __typename?: string;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  state?: string | null;
  author?: { login?: string | null } | null;
}

interface RawBoardItem {
  id: string;
  updatedAt?: string | null;
  type?: string | null;
  fieldValueByName?: { optionId?: string | null; name?: string | null } | null;
  content?: RawBoardContent | null;
}

interface RawBoardData {
  node?: {
    field?: RawBoardField | null;
    items?: { nodes?: (RawBoardItem | null)[] | null } | null;
  } | null;
}

// ── Reads (THROW on error) ────────────────────────────────────────────────────

/**
 * The repo's GitHub Projects (v2), newest-updated first. Capped at the 20 most
 * recently touched — the same magnitude as the PR/issue lists. Errors propagate.
 */
export async function listProjects(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<ProjectInfo[]> {
  const data = await client.graphql<RawProjectsData>(
    `query($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        projectsV2(first:20,orderBy:{field:UPDATED_AT,direction:DESC}){
          nodes{ id number title shortDescription url closed updatedAt items{totalCount} }
        }
      }
    }`,
    { owner, repo },
  );
  const nodes = data?.repository?.projectsV2?.nodes ?? [];
  return nodes
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      shortDescription: p.shortDescription ?? "",
      url: p.url,
      itemCount: p.items?.totalCount ?? 0,
      closed: p.closed,
      updatedAt: p.updatedAt ?? "",
    }));
}

/**
 * A project's board: its "Status" single-select field (the columns) plus every
 * item (cards) with its content + current Status value. Items are paged to the
 * first 100, ordered by board POSITION so columns read top-to-bottom as they do
 * on github.com. Errors propagate.
 *
 * The board read acts on an opaque ProjectV2 node id, so it ignores owner/repo —
 * they're accepted to keep the (client, owner, repo, …args) shape main.ts wires
 * through `github.withRepo`.
 */
export async function getProjectBoard(
  client: GitHubClient,
  _owner: string,
  _repo: string,
  projectId: string,
): Promise<ProjectBoard> {
  const data = await client.graphql<RawBoardData>(
    `query($id:ID!){
      node(id:$id){
        ... on ProjectV2 {
          field(name:"Status"){
            ... on ProjectV2SingleSelectField {
              id name options{ id name color }
            }
          }
          items(first:100,orderBy:{field:POSITION,direction:ASC}){
            nodes{
              id updatedAt type
              fieldValueByName(name:"Status"){
                ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
              }
              content{
                __typename
                ... on Issue       { number title url state author{login} }
                ... on PullRequest { number title url state author{login} }
                ... on DraftIssue  { title }
              }
            }
          }
        }
      }
    }`,
    { id: projectId },
  );
  const proj = data?.node;
  const rawField = proj?.field;
  const field: ProjectBoard["field"] = rawField
    ? {
        id: rawField.id,
        name: rawField.name,
        options: (rawField.options ?? [])
          .filter((o): o is NonNullable<typeof o> => !!o)
          .map((o) => ({ id: o.id, name: o.name, color: o.color ?? "" })),
      }
    : null;
  const items = (proj?.items?.nodes ?? [])
    .filter((n): n is RawBoardItem => !!n && !!n.content)
    .map((n) => {
      const c = n.content as RawBoardContent;
      return {
        id: n.id,
        type: n.type ?? "",
        title: c.title ?? "(untitled)",
        number: typeof c.number === "number" ? c.number : null,
        state: c.state ?? "",
        url: c.url ?? null,
        author: c.author?.login ?? "",
        statusOptionId: n.fieldValueByName?.optionId ?? null,
        statusName: n.fieldValueByName?.name ?? "",
        updatedAt: n.updatedAt ?? "",
      };
    });
  return { field, items };
}

// ── Mutations (return { ok, changed, message }) ───────────────────────────────

/**
 * Move an item to a Status option, or clear its Status when `optionId` is null.
 * Clearing uses a different mutation (clearProjectV2ItemFieldValue) than setting
 * (updateProjectV2ItemFieldValue). Needs the WRITE `project` scope; without it
 * GitHub returns a 403 whose message we surface verbatim (no crash).
 */
export async function moveProjectItem(
  client: GitHubClient,
  _owner: string,
  _repo: string,
  req: { projectId: string; itemId: string; fieldId: string; optionId: string | null },
): Promise<CommitActionResult> {
  try {
    if (req.optionId === null) {
      await client.graphql<{ clearProjectV2ItemFieldValue?: { clientMutationId?: string | null } }>(
        `mutation($p:ID!,$i:ID!,$f:ID!){
          clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){ clientMutationId }
        }`,
        { p: req.projectId, i: req.itemId, f: req.fieldId },
      );
    } else {
      await client.graphql<{ updateProjectV2ItemFieldValue?: { projectV2Item?: { id: string } | null } }>(
        `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
          updateProjectV2ItemFieldValue(input:{
            projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}
          }){ projectV2Item{ id } }
        }`,
        { p: req.projectId, i: req.itemId, f: req.fieldId, o: req.optionId },
      );
    }
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Add an existing issue/PR (by its content node id) to a project. v1.1 scaffold:
 * fully wired end to end so a future "Add item" affordance only needs a content
 * id. Needs the WRITE `project` scope.
 */
export async function addProjectItem(
  client: GitHubClient,
  _owner: string,
  _repo: string,
  req: { projectId: string; contentId: string },
): Promise<CommitActionResult> {
  try {
    await client.graphql<{ addProjectV2ItemById?: { item?: { id: string } | null } }>(
      `mutation($p:ID!,$c:ID!){
        addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } }
      }`,
      { p: req.projectId, c: req.contentId },
    );
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
  }
}
