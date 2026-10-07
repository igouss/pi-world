declare const BUILD: string;

/** The git revision this bundle was deployed from, stamped by `scripts/deploy.sh`; "dev" under `celld dev`. */
export const build: string = BUILD;
