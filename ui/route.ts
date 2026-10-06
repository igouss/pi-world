import { useEffect, useState } from "preact/hooks";
import { worldHash } from "../src/api/paths.ts";

/** The hash route: `#/w/:id` selects a world. */
export function useRoute(): { worldId?: string } {
	const parse = () => {
		const match = /^#\/w\/([a-z0-9-]+)/.exec(location.hash);
		return match ? { worldId: match[1] } : {};
	};
	const [route, setRoute] = useState(parse);
	useEffect(() => {
		const update = () => setRoute(parse());
		window.addEventListener("hashchange", update);
		return () => window.removeEventListener("hashchange", update);
	}, []);
	return route;
}

export function openWorld(id: string): void {
	location.hash = worldHash(id);
}
