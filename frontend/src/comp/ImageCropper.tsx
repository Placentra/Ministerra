import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import imageCompression from 'browser-image-compression';

const MAX_IMAGE_WIDTH = 3000; // Limit for maximum width
const MAX_IMAGE_HEIGHT = 3000; // Limit for maximum height
const MAX_IMAGE_SIZE_MB = 5; // Limit for maximum image size in MB
const CROP_WIDTH_COEF = 0.9; // Initial crop width as a percentage of canvas width
const CROP_HEIGHT_COEF = 0.8; // Initial crop height as a percentage of canvas height

// BUG image is distorted after save, like its zoomed in or something

const ImageCropper = props => {
	const { data, superMan, nowAt, isIntroduction } = props,
		[canvasRef, imageRef, deboCalcCoverage, deboFinalImg, canvasWrapper] = [useRef(null), useRef(null), useRef(null), useRef(null), useRef(null)],
		[originalImageSrc, setOriginalImageSrc] = useState(null),
		[imageSrc, setImageSrc] = useState(() => {
			if (data.imgVers && data.id) {
				const folder = nowAt === 'editor' ? 'events' : 'users';
				const url = `${import.meta.env.VITE_BACK_END}/public/${folder}/${data.id}_${data.imgVers}${folder === 'events' ? 'L' : ''}.webp`;
				// Set original image source when component mounts
				setOriginalImageSrc(url);
				return url;
			}
			return null;
		}),
		[crop, setCrop] = useState({ x: 0, y: 0 }),
		[zoom, setZoom] = useState(1),
		[rotation, setRotation] = useState(0),
		[aspect, setAspect] = useState(() => {
			return nowAt === 'editor' ? 1.777 : 1.6;
		}),
		[canvasDimensions, setCanvasDimensions] = useState(),
		[dragging, setDragging] = useState(false),
		[dragStart, setDragStart] = useState({ x: 0, y: 0 }),
		[isAreaCovered, setIsAreaCovered] = useState(true),
		{ width, height } = canvasDimensions || {},
		[activeSlider, setActiveSlider] = useState(null),
		sliderProps = useRef({
			aspect: { min: 0.5, max: 2.5, step: 0.1 },
			rotation: { min: -180, max: 180, step: 0.1 },
			zoom: { min: 0.1, max: 2, step: 0.001 },
		});

	const setFinalImage = async () => {
		if (!canvasRef.current || !imageRef.current || !width || !height) return;

		const getCropDims = () => {
			const cropWidth = Math.min(width * CROP_WIDTH_COEF, height * CROP_HEIGHT_COEF * aspect);
			const cropHeight = cropWidth / aspect;
			const cropX = (width - cropWidth) / 2;
			const cropY = (height - cropHeight) / 2;

			return { cropWidth, cropHeight, cropX, cropY };
		};

		async function getCroppedImage() {
			return new Promise(resolve => {
				const { cropWidth, cropHeight, cropX, cropY } = getCropDims();
				const img = imageRef.current;

				// ------------------------------------------------------------
				// Map crop rectangle (canvas space) back to image space
				// ------------------------------------------------------------
				const invZoom = 1 / zoom;

				// Source rectangle size in original image pixels
				const srcW = cropWidth * invZoom;
				const srcH = cropHeight * invZoom;

				// Offset introduced by panning (crop.x / crop.y)
				// In image pixels this offset has to be divided by zoom
				const offsetX = crop.x * invZoom;
				const offsetY = crop.y * invZoom;

				// Center of the source rectangle in the original image
				const srcCX = img.width / 2 - offsetX;
				const srcCY = img.height / 2 - offsetY;

				// Top-left corner of the rectangle in image space
				const srcX = srcCX - srcW / 2;
				const srcY = srcCY - srcH / 2;

				// ------------------------------------------------------------
				// Draw to output canvas
				// ------------------------------------------------------------
				const outCanvas = document.createElement('canvas');
				outCanvas.width = cropWidth;
				outCanvas.height = cropHeight;
				const outCtx = outCanvas.getContext('2d');

				// Place the image so that the desired region fills the canvas
				outCtx.save();
				// Move to canvas centre – makes rotation easier
				outCtx.translate(cropWidth / 2, cropHeight / 2);
				// Apply rotation (same as preview)
				outCtx.rotate((rotation * Math.PI) / 180);
				// Draw the extracted region; after rotation the rectangle is centred, so draw at -(w/2,h/2)
				outCtx.drawImage(img, srcX, srcY, srcW, srcH, -cropWidth / 2, -cropHeight / 2, cropWidth, cropHeight);
				outCtx.restore();

				outCanvas.toBlob(
					blob => {
						if (!blob) outCanvas.toBlob(b => resolve(b), 'image/jpeg');
						else resolve(blob);
					},
					'image/webp',
					0.85
				);
			});
		}

		try {
			const croppedImageBlob: any = await getCroppedImage();
			if (!croppedImageBlob) throw new Error('Failed to create blob from cropped image');

			const file = new File([croppedImageBlob as any], 'image.webp', { type: croppedImageBlob?.type || 'image/webp' });

			const options = {
				maxSizeMB: nowAt === 'editor' ? 0.3 : 0.15,
				maxWidthOrHeight: nowAt === 'editor' ? 1920 : 600,
				useWebWorker: true,
				fileType: 'image/webp',
			};

			const compressedFile = await imageCompression(file, options);
			const arrayBuffer = await compressedFile.arrayBuffer();
			const uint8Array = new Uint8Array(arrayBuffer);
			superMan('image', Array.from(uint8Array));
		} catch (error) {
			console.error('Image compression or conversion failed:', error);
		}
	};

	// READ FILE -------------------------------------------------------------
	const readFile = file =>
		new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.readAsDataURL(file);
		});

	// ON FILE CHANGE --------------------------------------------------------
	const onFileChange = async e => {
		const file = e.target.files?.[0];
		if (!file) return;
		if (file.size / 1024 / 1024 > MAX_IMAGE_SIZE_MB) return alert(`Image size exceeds the ${MAX_IMAGE_SIZE_MB}MB limit.`);

		const img = new Image();
		img.src = URL.createObjectURL(file);
		await img.decode();

		if (img.width > MAX_IMAGE_WIDTH || img.height > MAX_IMAGE_HEIGHT) return alert(`Image resolution exceeds the ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT} limit.`);

		// If this is the first image change, save the original
		if (!originalImageSrc && imageSrc) {
			setOriginalImageSrc(imageSrc);
		}

		setImageSrc(await readFile(file));
	};

	function updateCanvasDimensions() {
		if (!canvasWrapper.current) return;
		setCanvasDimensions({
			width: canvasWrapper.current.offsetWidth,
			height: Math.max(300, document.documentElement.clientHeight * (!isIntroduction ? 0.5 : 0.3)),
		});
	}

	// INITIALIZE IMAGE -------------------------------------------------------
	useLayoutEffect(() => {
		if (imageSrc) {
			const img = new Image();
			img.src = imageSrc;
			img.onload = () => {
				imageRef.current = img;
				updateCanvasDimensions();
				setFinalImage(); // Call setFinalImage after updating the canvas dimensions
			};
			img.onerror = () => {
				// If we tried small variant first, fall back to full-size image once
				if (imageSrc.endsWith('S.webp')) {
					const fullSrc = imageSrc.replace(/S\.webp$/, '.webp');
					fetch(fullSrc, { method: 'HEAD' })
						.then(resp => {
							if (resp.ok) setImageSrc(fullSrc);
							else {
								setImageSrc(null);
								superMan('image', null);
							}
						})
						.catch(() => {
							setImageSrc(null);
							superMan('image', null);
							console.error('Error loading image from URL:', imageSrc);
						});
				} else {
					console.error('Error loading image from URL:', imageSrc);
					setImageSrc(null);
					superMan('image', null);
				}
			};
		}
	}, [imageSrc]);

	// UPDATE CANVAS DIMENSIONS ON RESIZE ------------------------------------
	useEffect(() => {
		window.addEventListener('resize', updateCanvasDimensions);
		return () => window.removeEventListener('resize', updateCanvasDimensions);
	}, []);

	useLayoutEffect(() => {
		if (imageRef.current) drawCanvas(), checkAreaCoverage();
	}, [zoom, rotation, crop, aspect, canvasDimensions]);

	useLayoutEffect(() => {
		if (imageRef.current) fitImageToCanvas(), setFinalImage();
	}, [canvasDimensions]);

	// FIT IMAGE TO CANVAS -----------------------------------------------------
	const fitImageToCanvas = () => {
		const { width: imgW, height: imgH } = imageRef.current;
		const [aspectRatio, scaleW, scaleH] = [imgW / imgH, (width * CROP_WIDTH_COEF) / imgW, (height * CROP_HEIGHT_COEF) / imgH];
		sliderProps.current.zoom.min = Math.min(scaleW, scaleH) * 1.02;
		// CLEAR DEBOUNCE TO PREVENT OVERRIDE OF isAreaCovered -------------------
		if (deboCalcCoverage.current) clearTimeout(deboCalcCoverage.current);
		setAspect(nowAt === 'editor' ? aspectRatio : 1.6);
		setZoom(sliderProps.current.zoom.min), setCrop({ x: 0, y: 0 }), setRotation(0), setIsAreaCovered(true);
	};

	// DRAW CANVAS -------------------------------------------------------------
	const drawCanvas = useCallback(() => {
		if (!canvasRef.current || !imageRef.current) return;
		const canvas = canvasRef.current;
		const ctx = canvas.getContext('2d');
		const image = imageRef.current;
		if (!canvas || !image) return;

		const cropWidth = Math.min(width * CROP_WIDTH_COEF, height * CROP_HEIGHT_COEF * aspect);
		const cropHeight = cropWidth / aspect;

		ctx.clearRect(0, 0, width, height);
		ctx.save();
		ctx.translate(width / 2 + crop.x, height / 2 + crop.y);
		ctx.rotate((rotation * Math.PI) / 180);
		ctx.scale(zoom, zoom);
		ctx.drawImage(image, -image.width / 2, -image.height / 2);
		ctx.restore();
		ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';

		ctx.beginPath(), ctx.rect((width - cropWidth) / 2, (height - cropHeight) / 2, cropWidth, cropHeight), ctx.rect(0, 0, width, height), ctx.fill('evenodd');
		(ctx.strokeStyle = 'lightGreen'), (ctx.lineWidth = 3), ctx.strokeRect((width - cropWidth) / 2, (height - cropHeight) / 2, cropWidth, cropHeight);

		checkAreaCoverage();
	}, [canvasDimensions, crop, zoom, rotation, aspect]);

	// CHECK CROP AREA COVERAGE -------------------------------------------------------
	const checkAreaCoverage = () => {
		const image = imageRef.current;
		if (!image) return true;

		// Clear debounce if active
		if (deboCalcCoverage.current) clearTimeout(deboCalcCoverage.current);
		const { width: imgW, height: imgH } = image;

		// Calculate crop dimensions using the same logic as drawing & exporting
		const cropWidth = Math.min(width * CROP_WIDTH_COEF, height * CROP_HEIGHT_COEF * aspect);
		const cropHeight = cropWidth / aspect;
		const cropLeft = (width - cropWidth) / 2;
		const cropTop = (height - cropHeight) / 2;

		// Scaled image dimensions
		const scaledWidth = imgW * zoom;
		const scaledHeight = imgH * zoom;

		// Image center in canvas coordinates
		const centerX = width / 2 + crop.x;
		const centerY = height / 2 + crop.y;

		// Rotation in radians
		const radians = (rotation * Math.PI) / 180;
		const cos = Math.cos(radians);
		const sin = Math.sin(radians);

		// Function to calculate rotated point
		const rotatePoint = ({ x, y }) => ({
			x: centerX + (x - centerX) * cos - (y - centerY) * sin,
			y: centerY + (x - centerX) * sin + (y - centerY) * cos,
		});

		// Corners of the scaled and rotated image
		const imageCorners = [
			{ x: centerX - scaledWidth / 2, y: centerY - scaledHeight / 2 },
			{ x: centerX + scaledWidth / 2, y: centerY - scaledHeight / 2 },
			{ x: centerX + scaledWidth / 2, y: centerY + scaledHeight / 2 },
			{ x: centerX - scaledWidth / 2, y: centerY + scaledHeight / 2 },
		].map(rotatePoint);

		// Corners of the crop area (not rotated)
		const cropCorners = [
			{ x: cropLeft, y: cropTop },
			{ x: cropLeft + cropWidth, y: cropTop },
			{ x: cropLeft + cropWidth, y: cropTop + cropHeight },
			{ x: cropLeft, y: cropTop + cropHeight },
		];

		// Check if all crop corners are within the rotated image bounds
		const isPointInPolygon = (point, polygon) => {
			let inside = false;
			for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
				const xi = polygon[i].x,
					yi = polygon[i].y;
				const xj = polygon[j].x,
					yj = polygon[j].y;
				const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
				if (intersect) inside = !inside;
			}
			return inside;
		};

		const isCovered = cropCorners.every(cropCorner => isPointInPolygon(cropCorner, imageCorners));
		deboCalcCoverage.current = setTimeout(() => setIsAreaCovered(isCovered), 200);
	};

	// ADD / REMOVE EVENT LISTENERS ----------------------------------------------
	const processListeners = mode => ['mousemove', 'mouseup', 'touchmove', 'touchend'].forEach((event, i) => window[`${mode}EventListener`](event, i % 2 !== 0 ? endDrag : onDrag));
	useEffect(() => {
		if (!activeSlider && dragging) processListeners('add');
		return () => processListeners('remove');
	}, [dragStart, activeSlider]);

	// HANDLE DRAGGING -----------------------------------------------------------
	const startDrag = e => {
		e.preventDefault();
		const rect = canvasRef.current.getBoundingClientRect();
		const mouseX = (e.clientX || e.touches[0].clientX) - rect.left;
		const mouseY = (e.clientY || e.touches[0].clientY) - rect.top;

		const { width, height } = canvasRef.current;
		const cropWidth = Math.min(width * CROP_WIDTH_COEF, height * CROP_HEIGHT_COEF * aspect);
		const cropHeight = cropWidth / aspect;
		const cropX = (width - cropWidth) / 2 + crop.x;
		const cropY = (height - cropHeight) / 2 + crop.y;

		const insideImage = mouseX >= cropX && mouseX <= cropX + cropWidth && mouseY >= cropY && mouseY <= cropY + cropHeight;
		if (insideImage) setDragging(true), setDragStart({ x: mouseX - crop.x, y: mouseY - crop.y });
	};

	// HANDLE DRAGGING -----------------------------------------------------------
	const onDrag = e => {
		e.preventDefault();
		if (dragging) {
			const rect = canvasRef.current.getBoundingClientRect();
			const mouseX = (e.clientX || e.touches[0].clientX) - rect.left;
			const mouseY = (e.clientY || e.touches[0].clientY) - rect.top;
			setCrop({ x: mouseX - dragStart.x, y: mouseY - dragStart.y });
		}
	};

	// HANDLE TOUCH EVENTS -------------------------------------------------------
	const endDrag = () => (setDragging(false), setDragStart({ x: 0, y: 0 }), clearTimeout(deboFinalImg.current), (deboFinalImg.current = setTimeout(() => setFinalImage(), 1000)));
	const handleTouchStart = e => {
		if (e.touches.length === 1) {
			e.preventDefault();
			startDrag(e);
		} else if (e.touches.length === 2) {
			const [touch1, touch2] = e.touches;
			const distance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
			const angle = Math.atan2(touch2.clientY - touch1.clientY, touch2.clientX - touch1.clientX);
			setDragStart({ distance, angle });
		}
	};

	// HANDLE TOUCH MOVE ---------------------------------------------------------
	const handleTouchMove = e => {
		if (e.touches.length === 1) {
			e.preventDefault();
			onDrag(e);
		} else if (e.touches.length === 2) {
			const [touch1, touch2] = e.touches;
			const distance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
			const angle = Math.atan2(touch2.clientY - touch1.clientY, touch2.clientX - touch1.clientX);
			const scaleChange = distance / dragStart.distance;
			const rotationChange = angle - dragStart.angle;
			setZoom(prevZoom => Math.min(2, Math.max(0.5, prevZoom * scaleChange)));
			setRotation(prevRotation => prevRotation + (rotationChange * 180) / Math.PI);
			setDragStart({ distance, angle });
		}
	};

	const handleTouchEnd = e => e.touches.length < 2 && endDrag();
	const handleSliderChange = e => {
		if (!activeSlider) return;
		const value = parseFloat(e.target.value);
		const handlers = { zoom: () => setZoom(Math.min(2, Math.max(sliderProps.current.zoom.min, value))), rotation: () => setRotation(value), aspect: () => setAspect(value) };
		handlers[activeSlider]();
	};

	// UPDATE FINAL IMAGE WHEN SLIDER CHANGES (DEBOUNCED) ---------------------------
	useEffect(() => {
		if (!imageRef.current) return;
		if (deboFinalImg.current) clearTimeout(deboFinalImg.current);
		deboFinalImg.current = setTimeout(() => setFinalImage(), 500);
	}, [zoom, rotation, aspect]);

	return (
		<image-cropper class={`w100 ${isIntroduction ? 'mw160 marAuto' : ''} ${nowAt === 'editor' ? 'marBotM' : ''}  boRadS overHidden marAuto  block posRel`}>
			{!imageSrc ? (
				<load-image name='image' className='w100 block   marAuto pointer posRel'>
					{/* TITLE TEXTS ------------------------------------------------- */}
					{data.id && (
						<title-texts class='posRel block'>
							<span className='xBold marBotXxxs fs10 block'>Profilová fotka</span>
							<p className='fs6 marBotXs mw160 lh1 marAuto'>Však to znáš, s profilovkou budeš mít o dost větší šanci na úspěch.</p>
						</title-texts>
					)}

					{/* LOAD IMAGE PLACEHOLDER -------------------------------------- */}
					<img-load
						className='flexCol justCen aliCen gapXs  iw33 shaBotLongDown imw12 fPadHorXs  w100 hvw10 bInsetBlueTopXs2  bBor borBotLight  mih10 marAuto posRel'
						onClick={() => document.querySelector('#file').click()}>
						<img src='/icons/placeholdergood.png' alt='' className='bHover boRadXs shaCon' />
						<span className='fs13'>Klikni pro nahrání obrázku</span>
					</img-load>
					<input title='Klikni pro nahrání obrázku' className='hide' type='file' id='file' onChange={onFileChange} accept='image/*' />

					{/* REVERT BUTTON WHEN IMAGE IS REMOVED ------------------------- */}
					{originalImageSrc && (
						<button
							className={'boldS fs8 textSha bDarkRed tWhite shaBlue bInsetBlue miw50 padVerXxs boRadXs marTopXs block marAuto'}
							onClick={() => {
								setImageSrc(originalImageSrc);
								fitImageToCanvas();
							}}>
							Vrátit obrázek
						</button>
					)}
				</load-image>
			) : (
				<>
					<canvas-wrapper ref={canvasWrapper} class={`  shaTop block bgLightBlue borTop  w100 posRel ${isAreaCovered ? '' : 'inform'}`}>
						{/* CANVAS -------------------------------------------------- */}
						<canvas
							className={'  posRel'}
							ref={canvasRef}
							width={width}
							height={height}
							onMouseDown={startDrag}
							onTouchStart={handleTouchStart}
							onTouchMove={handleTouchMove}
							onTouchEnd={handleTouchEnd}
						/>

						{/* SLIDERS -------------------------------------------------- */}
						<div className='slider-container  posAbs botCen marAuto fPadHorS marBotS w100 growAll flexCen wrap gapXs'>
							{['zoom', 'rotation', ...(nowAt === 'editor' ? ['aspect'] : [])].map(mode => (
								<input-wrapper key={mode} class='block grow posRel'>
									<input
										className={'pointer sliderHover  w100 cropperSlider'}
										{...sliderProps.current[mode]}
										value={mode === 'zoom' ? zoom : mode === 'rotation' ? rotation : aspect}
										type='range'
										onMouseDown={() => setActiveSlider(mode)}
										onMouseUp={() => setActiveSlider(null)}
										onInput={handleSliderChange}
										onChange={handleSliderChange}
										onTouchStart={() => setActiveSlider(mode)}
										onTouchEnd={() => setActiveSlider(null)}
									/>
									<span className='posRel fs8 bold textSha posAbs botCen noPoint  padHorXs upTinyBit bgTrans  shaCon  inlineBlock'>
										{mode === 'zoom' ? 'příblížení' : mode === 'rotation' ? 'otočení' : 'tvar ořezu'}
									</span>
								</input-wrapper>
							))}
						</div>
					</canvas-wrapper>

					{/* CROP AREA NOT COVERED INFORM ------------------------------------------------ */}
					{!isAreaCovered && <div className='padVerXxxs borTop 	 tWhite fs11 bBlue tSha10 boldS w100 inlineBlock'>Plocha výřezu není zcela zakrytá (NEPOVINNÉ)</div>}

					{/* BASICS CONTROLS BS -------------------------------------------------------------- */}
					<div style={{ filter: 'saturate(0.8)' }} className=' 	hvw8 mh5 growAll  gapXxxs flexCen posRel bInsetBlueTop  w100 mw120 marAuto'>
						<blue-divider style={{ filter: 'brightness(0.7)' }} class={`hr0-5 borTop block posAbs zinMaXl topCen bInsetBlueTopXl borTop bgTrans w100 marAuto`} />

						<button className={'xBold fs10  textSha   bHover  h100 bgTrans  shaBlue '} onClick={() => document.querySelector('#file').click()}>
							Změnit obrázek
						</button>
						<button className={'xBold fs10  textSha   bHover h100 bgTrans  shaBlue '} onClick={fitImageToCanvas}>
							Reset pozice
						</button>
						<button className={'xBold fs10  textSha  bHover h100 bgTrans  shaBlue '} onClick={() => (setImageSrc(null), superMan('image', null))}>
							Odstranit obrázek
						</button>
						{originalImageSrc && imageSrc !== originalImageSrc && (
							<button
								className={'xBold fs10 textSha bDarkBlue tWhite  shaBlue '}
								onClick={() => {
									setImageSrc(originalImageSrc);
									fitImageToCanvas();
								}}>
								Vrátit obrázek
							</button>
						)}
						<blue-divider style={{ filter: 'brightness(1)' }} class={`hr0-3 opacityS borTop block posAbs zinMaXl botCen bInsetBlueTopXl borTop bgTrans w100 marAuto`} />
					</div>
				</>
			)}

			{/* HIDDEN FILE CHANGE INPUT ----------------------------------------------------------- */}
			<input type='file' id='file' onChange={onFileChange} accept='image/*' hidden />
		</image-cropper>
	);
};

export default ImageCropper;
