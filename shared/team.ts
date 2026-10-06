import type { SdlcEnvironment } from "./types.ts";

/**
 * The settings that shared code reads, in the server and in the page: whose dashboard it is,
 * where reviews are asked for, which repos deploy, and which environments a team tests on.
 * The server sets them from the config file at start, and the page from each dashboard load,
 * so the many shared functions that read them do not each take them as an argument.
 */
export interface Team {
  /** Your first name, as agents call you in their prompts. Empty: "the user". */
  userName: string;
  /** The Slack channel for PR review requests. Empty id: no review requests. */
  reviewChannelId: string;
  reviewChannelName: string;
  /** Repos whose PRs need no Slack review request, such as your own tools. */
  noReviewRepos: string[];
  /** A merged PR in one of these deploys a chart version to Beta or Prod. */
  deployRepoBeta: string;
  deployRepoProd: string;
  /** The environments that a smoketest can run on. Old events keep their other environments. */
  environments: SdlcEnvironment[];
}

export const DEFAULT_TEAM: Team = {
  userName: "",
  reviewChannelId: "",
  reviewChannelName: "",
  noReviewRepos: [],
  deployRepoBeta: "postman-eng/cloud9-parcels-deployments",
  deployRepoProd: "postman-eng/cloud9-parcels-production-deployments",
  environments: ["localhost", "postman_beta", "postman_prod"],
};

export const team: Team = { ...DEFAULT_TEAM };

/** The team fields of a larger object, such as the whole settings. */
export const teamOf = (s: Team): Team => Object.fromEntries(Object.keys(DEFAULT_TEAM).map((k) => [k, s[k as keyof Team]])) as unknown as Team;

export function setTeam(t: Team): void {
  Object.assign(team, teamOf(t));
}

/** The user, as an agent prompt names them in the middle of a sentence. */
export const user = (): string => team.userName || "the user";
/** The user at the start of a sentence. */
export const User = (): string => team.userName || "The user";
