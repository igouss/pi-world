/** The URLs of a world, shared by the cell, the pages it serves and the web UI. */
export const worldHash = (id: string): string => `#/w/${id}`;
export const appPath = (id: string): string => `/w/${id}/`;
export const callPath = (id: string, name: string): string => `/api/worlds/${id}/call/${encodeURIComponent(name)}`;
