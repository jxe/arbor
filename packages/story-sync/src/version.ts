declare const STORY_PACKAGE_VERSION: string | undefined;

/** The version Story Sync and the `story` command report. A packaged build
 * defines it from the published manifest; a checkout reports the workspace version. */
export const STORY_VERSION: string = typeof STORY_PACKAGE_VERSION === "string" ? STORY_PACKAGE_VERSION : "0.1.0";
