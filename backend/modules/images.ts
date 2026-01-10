import sharp from 'sharp';
import { Catcher } from '../systems/systems.ts';
import fs from 'fs/promises';
import { Sql } from '../systems/systems.ts';
import { getLogger } from '../systems/handlers/loggers.ts';
import { Request, Response, NextFunction } from 'express';

interface ProcessedImage {
	size: string;
	buffer: Buffer;
}

interface ImageProcessingResult {
	processedImages: ProcessedImage[];
	height: number;
}

interface ImagesRequest extends Request {
	processedImages?: ProcessedImage[];
	body: {
		userID: string | number;
		eventID?: string | number;
		image?: number[] | Uint8Array | null;
		imgVers?: string | number;
	};
}

// IMAGES MODULE ----------------------------------------------------------------
// Handles image upload preprocessing:
// - validate payload and image format
// - produce optimized WebP renditions
// - write user images immediately; defer event images for authorization phase

const logger = getLogger('Images');

// HELPERS ---------------------------------------------------------------------

// PROCESS IMAGES ---------------------------------------------------------------
// Steps: read original metadata, then render a small set of WebP renditions; for events we capture a reference height so imgVers encodes a stable layout hint.
const processImages = async (buffer: Buffer, imgFolder: 'events' | 'users'): Promise<ImageProcessingResult> => {
	const sizeConfigs = {
		events: [{ size: 100, name: 'S' }, { size: 600 }, { size: 1920, name: 'L' }],
		users: [{ size: 100, name: 'S' }, { size: 600 }],
	};

	// ORIGINAL META ----------------------------------------------------------
	// Steps: read once so we can return height even when a later rendition path fails to capture it.
	const originalMeta = await sharp(buffer).metadata();
	let height: number | undefined;
	const processedImages: ProcessedImage[] = [];

	// PROCESSING LOOP --------------------------------------------------------
	// Steps: process serially so a single request can’t saturate the sharp thread pool and starve other requests.
	for (const config of sizeConfigs[imgFolder]) {
		const img = sharp(buffer)
			.resize(config.size || undefined)
			.webp({ quality: 85, effort: 4 });

		const metadata = await img.metadata();
		if (imgFolder === 'events' && !config.name) height = metadata.height;

		const imageBuffer = await img.toBuffer();
		processedImages.push({
			size: config.name || '',
			buffer: imageBuffer,
		});
	}

	return { processedImages, height: height || originalMeta.height || 0 };
};

// SAVE IMAGES ------------------------------------------------------------------
// Writes processed images to `public/<folder>/<id>_<imgVers><size>.webp`.
const saveImages = async (images: ProcessedImage[], targetID: number | string, imgVers: number | string, imgFolder: string): Promise<void> => {
	const directoryPath = `public/${imgFolder}/`;
	try {
		await fs.access(directoryPath);
	} catch {
		await fs.mkdir(directoryPath, { recursive: true });
	}

	// BOUNDED WRITE LOOP ------------------------------------------------------
	// Steps: write serially to avoid FD exhaustion and disk spikes on multi-image uploads.
	for (const img of images) await fs.writeFile(`${directoryPath}${targetID}_${imgVers}${img.size}.webp`, img.buffer);
};

// IMAGES MIDDLEWARE -----------------------------------------------------------

// IMAGES ---
// Express middleware guarding image uploads and wiring processed assets to downstream handlers.
// Validates upload payloads, produces optimized WebP renditions and updates `imgVers` counters.
const Images = async (req: ImagesRequest, res: Response, next: NextFunction) => {
	let con: any, imgVers: any;

	try {
		const { userID, eventID, image } = req.body;
		const imgFolder: 'events' | 'users' | '' = req.url.includes('editor') ? 'events' : req.url.includes('setup') ? 'users' : '';
		const targetID = imgFolder === 'users' ? userID : eventID;

		// PASS-THROUGH CHECK --------------------------------------------------
		// Steps: only intercept when `image` field exists; otherwise let downstream handlers proceed unchanged.
		if (image === undefined) return next();
		// DELETE IMAGE LOGIC --------------------------------------------------
		// Steps: when image=null, delete user images (if any), zero imgVers, then let downstream handlers persist the cleared state.
		else if (image === null) {
			if (imgFolder === 'users') {
				con = await Sql.getConnection();
				const [rows]: [any[], any] = await con.execute(`SELECT imgVers FROM users WHERE id = ?`, [userID]);
				imgVers = rows?.[0]?.imgVers || 0;
				if (imgVers) {
					for (const size of ['', 'S']) {
						try {
							await fs.unlink(`public/users/${userID}_${imgVers}${size}.webp`);
						} catch (error) {
							logger.error('removeUserImage', { error, userID, size });
						}
					}
				}
			}
			delete req.body.image;
			return (req.body.imgVers = 0), next();
		}

		// VALIDATION ----------------------------------------------------------
		// Steps: reject empty payloads and cap size before decoding so we don’t waste CPU on oversized buffers.
		if (!image || (Array.isArray(image) && image.length === 0)) throw new Error('invalidImage');
		if (Array.isArray(image) && image.length > 5 * 1024 * 1024) throw new Error('imageTooLarge');

		// SQL READ -------------------------------------------------------------
		// Steps: read current imgVers so we can increment; table is selected from a fixed map to avoid injection.
		con = await Sql.getConnection();
		// Validate imgFolder to prevent SQL injection
		const allowedTables: Record<string, string> = { events: 'events', users: 'users' };
		const safeTable = allowedTables[imgFolder];
		if (!safeTable) throw new Error('invalidImageFolder');
		const [rows]: [any[], any] = targetID ? await con.execute(`SELECT imgVers FROM ${safeTable} WHERE id = ?`, [targetID]) : [[{ imgVers: 0 }]];
		imgVers = rows[0]?.imgVers || 0;
		const buffer = Buffer.from(new Uint8Array(image as number[]));

		// FORMAT CHECK ---------------------------------------------------------
		// Steps: validate the buffer is a real image via sharp metadata; reject unsupported formats before doing expensive transforms.
		try {
			const meta = await sharp(buffer).metadata();
			if (!meta.format || !['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff'].includes(meta.format)) {
				throw new Error('unsupportedImageFormat');
			}
		} catch (sharpErr: any) {
			logger.error('Images validation failed', { error: sharpErr?.message, userID, eventID });
			throw new Error('invalidImage');
		}

		// PROCESSING -----------------------------------------------------------
		// Steps: generate renditions and capture height; actual saving may be deferred for events until authorization succeeds.
		const { processedImages, height } = await processImages(buffer, imgFolder as 'events' | 'users');

		delete req.body.image;

		// SAVE/DEFER LOGIC -----------------------------------------------------
		// Steps: events are deferred to Editor so auth can be enforced; user images are saved immediately after processing.
		if (imgFolder === 'events') {
			if (!eventID) {
				// New event: defer saving to Editor after event is created
				req.processedImages = processedImages;
				req.body.imgVers = `1_${Math.floor(height / 10)}`;
			} else {
				// Editing existing event: defer saving until authorization in Editor
				const newVImg = Number(imgVers) + 1;
				req.processedImages = processedImages;
				req.body.imgVers = `${newVImg}_${Math.floor(height / 10)}`;
			}
		} else {
			// User images can be saved immediately
			const newVImg = Number(imgVers) + 1;
			await saveImages(processedImages, targetID!, newVImg, imgFolder);
			req.body.imgVers = newVImg;
		}

		next();
	} catch (error) {
		logger.error('Images middleware failed', { error, req, userID: req.body?.userID, eventID: req.body?.eventID });
		Catcher({ origin: 'Images', error, res });
	} finally {
		if (con) con.release();
	}
};

export { Images, saveImages };
