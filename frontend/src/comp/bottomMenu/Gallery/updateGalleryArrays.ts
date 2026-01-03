// UPDATE GALLERY ARRAYS --------------------------------------------------------
// Steps: mutate brain.user.galleryIDs buckets by adding/removing a single itemId across multiple categories; supports both flat arrays and {sortKey->array} shapes.
export function updateGalleryArrays(brain, itemId, operations: any = {}) {
	const {
		addToOwn,
		addToInt,
		addToSurMay,
		removeFromInt,
		removeFromSurMay,
		addToLinks,
		removeFromLinks,
		addToRequests,
		removeFromRequests,
		addToTrusts,
		removeFromTrusts,
		addToBlocks,
		removeFromBlocks,
		addToInvitesIn,
		removeFromInvitesIn,
		addToInvitesOut,
		removeFromInvitesOut,
	} = operations;

	// HELPERS ------------------------------------------------------------------
	// Steps: isolate read/write paths so each operation is a small, predictable mutation.
	const getGallery = galleryKey => (brain.user.galleryIDs || {})[galleryKey];
	const addToGalleryArray = galleryKey => {
		// ADD ---------------------------------------------------------------
		// Steps: keep itemId at the front (recency), dedupe via Set, and update nested buckets when gallery is an object keyed by sort mode.
		const gallery = getGallery(galleryKey);
		if (!gallery) return;
		if (Array.isArray(gallery)) {
			brain.user.galleryIDs[galleryKey] = [...new Set([itemId, ...gallery.filter(id => id !== itemId)])];
		} else {
			Object.keys(gallery).forEach(sortKey => {
				const bucket = gallery[sortKey] || [];
				if (Array.isArray(bucket) && bucket.length > 0) gallery[sortKey] = [...new Set([itemId, ...bucket.filter(id => id !== itemId)])];
			});
		}
	};

	const removeFromGalleryArray = galleryKey => {
		// REMOVE ------------------------------------------------------------
		// Steps: remove itemId from the correct bucket shape; keeps other IDs stable so pagination cursors don’t jump unnecessarily.
		const gallery = getGallery(galleryKey);
		if (!gallery) return;
		if (Array.isArray(gallery)) {
			const idx = gallery.indexOf(itemId);
			if (idx > -1) gallery.splice(idx, 1);
		} else Object.keys(gallery).forEach(sortKey => (gallery[sortKey] = (gallery[sortKey] || []).filter(id => id !== itemId)));
	};

	// EVENT OPERATIONS ---------------------------------------------------------
	// Steps: update future-event buckets that drive gallery filters.
	if (addToOwn) addToGalleryArray('futuOwn');
	if (addToInt) addToGalleryArray('futuInt');
	if (addToSurMay) addToGalleryArray('futuSurMay');
	if (removeFromInt) removeFromGalleryArray('futuInt');
	if (removeFromSurMay) removeFromGalleryArray('futuSurMay');

	// USER OPERATIONS ----------------------------------------------------------
	// Steps: keep relationship buckets (links/requests/trusts/blocks) consistent for both UI lists and local filtering logic.
	if (addToLinks) addToGalleryArray('links');
	if (removeFromLinks) removeFromGalleryArray('links');
	if (addToRequests) addToGalleryArray('requests');
	if (removeFromRequests) removeFromGalleryArray('requests');
	if (addToTrusts) addToGalleryArray('trusts');
	if (removeFromTrusts) removeFromGalleryArray('trusts');
	if (addToBlocks) addToGalleryArray('blocks');
	if (removeFromBlocks) removeFromGalleryArray('blocks');

	// INVITE OPERATIONS --------------------------------------------------------
	// Steps: track inbound/outbound invite buckets so gallery can render “invites” views without extra scans.
	if (addToInvitesIn) addToGalleryArray('invitesIn');
	if (removeFromInvitesIn) removeFromGalleryArray('invitesIn');
	if (addToInvitesOut) addToGalleryArray('invitesOut');
	if (removeFromInvitesOut) removeFromGalleryArray('invitesOut');
}
