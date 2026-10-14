import { createClient, type Client } from "../src/api/client.ts";

/** The client of the server that serves the UI. */
export const api: Client = createClient("");
