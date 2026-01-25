import { useRef, useLayoutEffect, useState, memo, isValidElement } from 'react';

// TODO move the usemasonReize logic inside this component.
// BUG if last row is only 1 item shortDesc of being full, the items grow to fill the row instead of staying the same size as the rest and being centered. try with 4 columns and 3 items in last row

// MAX WIDTHS FOR DIFFERENT CONTENT TYPES --------------------------------------
const maxWidthSource = { users: 650, events: 1300, userStrips: 500, alertStrips: 650, eventStrips: 1300, eveStrips: 1300, chats: 1200, chatStrips: 1200, locaStrips: 450 };

/** ----------------------------------------------------------------------------
 * MASONRY LAYOUT ENGINE
 * Efficiently distributes content items into columns based on their estimated height.
 * Supports multi-column flows, strips, and balanced last-row alignment.
 * --------------------------------------------------------------------------- */
const Masonry = props => {
	// PROPS AND STATE INITIALIZATION ------------------------------------------
	const {
		content = [],
		nowAt,
		isChatSetup,
		config: { contType, numOfCols, noPadTop },
		Comp,
		cardProps,
	} = props;

	const [chunks, setChunks] = useState([]);
	const [view, setView] = useState(contType);
	const [numCols, setNumCols] = useState(numOfCols);
	const masonryRef = useRef(null);

	// CHUNK GENERATION AND HEIGHT BALANCING -----------------------------------
	// Re-calculates column distribution whenever content or layout configuration changes.
	useLayoutEffect(() => {
		if ((!chunks.length && !content?.length) || !numOfCols) return;

		// ESTIMATE HEIGHT FOR BALANCE ---------------------------
		const getHeight = card => {
			let cardHeight = 120; // BASE HEIGHT ---------------------------

			if (card.title?.length > 50) cardHeight += 30;
			else if (card.title?.length > 30) cardHeight += 20;

			if (card.shortDesc) {
				if (card.shortDesc.length > 200) cardHeight += 80;
				else if (card.shortDesc.length > 100) cardHeight += 50;
				else cardHeight += 30;
			}

			if (card.type.startsWith('a')) {
				cardHeight += 200;
				const attendees = (card.surely || 0) + (card.maybe || 0);
				if (attendees > 4) cardHeight += 40;
				if (attendees > 8) cardHeight += 40;
			} else if (card.imgVers) {
				cardHeight += 180;
			}

			if (card.badges?.length > 0) cardHeight += 25;
			if (card.location || card.place) cardHeight += 10;

			return cardHeight;
		};

		const [newChunks, heights] = [[], []];
		const CHUNK_SIZE = 20;

		// PROCESS CONTENT IN CHUNKS -------------------------------------------
		content.forEach((card, index) => {
			const chunkIndex = Math.floor(index / CHUNK_SIZE);
			if (!newChunks[chunkIndex]) {
				newChunks[chunkIndex] = Array(numOfCols)
					.fill(null)
					.map(() => []);
				heights[chunkIndex] = Array(numOfCols).fill(0);
			}
			let targetColIdx = 0;

			// BALANCING LOGIC ---------------------------
			if (contType !== 'events') targetColIdx = index % numOfCols;
			else {
				// Find column with minimum total estimated height ---------------------------
				let minColHeight = heights[chunkIndex][0];
				for (let i = 1; i < numOfCols; i++) if (heights[chunkIndex][i] < minColHeight) ((minColHeight = heights[chunkIndex][i]), (targetColIdx = i));
				heights[chunkIndex][targetColIdx] += getHeight(card);
			}
			newChunks[chunkIndex][targetColIdx].push(card);
		});

		// HANDLE LAST ROW CENTERING -------------------------------------------
		// If last chunk is only partial, center it by padding columns
		if (newChunks.length > 0 && !contType.includes('Strips')) {
			const lastIdx = newChunks.length - 1;
			const itemsInLastChunk = newChunks[lastIdx].flat().length;
			if (itemsInLastChunk < numOfCols) {
				const emptyCols = numOfCols - itemsInLastChunk;
				if (emptyCols > 0 && emptyCols % 2 === 0) {
					const padding = emptyCols / 2;
					const centered = Array(numOfCols)
						.fill(null)
						.map(() => []);
					for (let i = 0; i < itemsInLastChunk; i++) centered[padding + i] = newChunks[lastIdx][i];
					newChunks[lastIdx] = centered;
				}
			}
		}

		(setView(contType), setNumCols(numOfCols), setChunks(newChunks));
	}, [content, numOfCols, contType]);

	// RENDER MASONRY LAYOUT ---------------------------------------------------
	return (
		<masonry-wrapper ref={masonryRef} class={`block ${contType.includes('Strips') ? 'w100 marAuto padBotXs fPadHorXxxs   ' : nowAt !== 'event' ? 'mihvh120 w100' : 'w100'}  posRel block `}>
			<content-chunks class={` ${nowAt !== 'event' && !view.includes('Strips') ? ' block' : nowAt !== 'event' && !isChatSetup && !noPadTop ? 'padTopXs' : ''}  w100 posRel block  posRel   aliCen flexCol fPadHorXxxs  `}>
				{(() => {
					let cumulative = 0;
					return chunks?.map((chunk, i) => {
						const itemsCount = chunk.flat().filter(item => !isValidElement(item)).length;
						const start = cumulative + 1;
						cumulative += itemsCount;
						const end = cumulative;

						return (
							<single-chunk class={` aliCen ${contType.includes('Strips') ? '' : 'fPadHorXxxs'} block  w100`} key={i}>
								{i > 0 && nowAt !== 'event' && contType !== 'alertStrips' && (
									<chunks-divider
										class={`marVerS w100 block mw30 posRel textAli padVerXxs padHorXs marAuto boRadS fsD xBold`}
										style={{
											color: 'rgba(20, 60, 120, 0.9)',
											background: 'linear-gradient(90deg, rgba(30,144,255,0.12), rgba(30,144,255,0.06), rgba(30,144,255,0.12))',
											borderTop: '2px solid rgba(30,144,255,0.28)',
											letterSpacing: '0.03em',
										}}>
										{`${start} - ${end}`}
									</chunks-divider>
								)}
								{/* COLUMN GRID --------------------------- */}
								<cols-wrapper class={`${view === 'alertStrips' ? 'gapXxs' : view === 'pastUsers' ? 'gapXxs' : ['users', 'eveUsers'].includes(view) ? 'gapXs' : view.includes('Strips') ? 'gapXxs' : ['gapMiddleL', 'gapMiddleS', 'gapMiddleXs'][numCols > 3 ? 2 : numCols - 2]} flexCen w100 marAuto aliStart  spaceCen padBotXs `} key={i}>
									{chunk.map((cards, j) => {
										return (
											<content-column style={{ width: `${100 / numCols}%`, maxWidth: maxWidthSource[contType] ? `${maxWidthSource[contType]}px` : undefined }} class={`flexCol justStart grow ${nowAt !== 'event' ? 'downTinyBit' : ''} posRel   ${!view.includes('Strips') ? 'gapXxxs' : ''} aliCen   `} key={j}>
												{/* RENDER ITEMS OR PLACEHOLDERS --------------------------- */}
												{cards.map((item, idx) => (isValidElement(item) ? item : <Comp {...cardProps} key={item.id} obj={item} isFirstInCol={idx === 0} />))}
											</content-column>
										);
									})}
								</cols-wrapper>
							</single-chunk>
						);
					});
				})()}
			</content-chunks>
		</masonry-wrapper>
	);
};

// RENDER OPTIMIZATION -----------------------------------------------------
function areEqual(prev, next) {
	return prev.content === next.content && prev.nowAt === next.nowAt && prev.config.numOfCols === next.config.numOfCols && prev.config.contType === next.config.contType && prev.cardProps?.showAllThumbs === next.cardProps?.showAllThumbs && prev.cardProps?.cardsView === next.cardProps?.cardsView;
}

export default memo(Masonry, areEqual);
