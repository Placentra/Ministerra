import { useEffect, useState, useRef, useContext } from 'react';
import { globalContext } from '../contexts/globalContext';
import { notifyGlobalError } from '../hooks/useErrorsMan';

function TextArea(props) {
	const { menuView, isMobile } = useContext(globalContext);
	const { fadedIn = ['TextArea'], emptyDiscussion, attach, superMan, content = '', thisIs, target: id, isChatSetup, setModes = () => {}, showBackButton, viewSwitch, inform, setInform } = props;
	const [curContent, setCurContent] = useState(content);
	const textArea = useRef(null);
	const [disable, setDisable] = useState(false);
	const hideTextArea = () => setModes(prev => ({ ...prev, textArea: false }));
	const isEmpty = useRef(thisIs === 'newMessage' ? true : false);

	const bsActions = {
		left: { comment: () => hideTextArea(), message: () => hideTextArea() },
		right: {
			newMessage: async () => {
				try {
					if (!curContent.trim() && !attach) {
						console.error('Cannot send empty message');
						return;
					}

					const trimmedContent = curContent.trim();
					const result = await superMan({
						mode: 'postMessage',
						content: trimmedContent,
						attach,
					});
					if (result === 'throttled') return;

					// Only clear on success
					if (result !== 'throttled') {
						if (textArea.current) textArea.current.innerText = '';
						setCurContent('');
					}
				} catch (error) {
					console.error('Error sending message:', error);
					notifyGlobalError(error, 'Nepodařilo se odeslat zprávu.');
					// Don't clear input on error so user can retry
				}
			},
			message: async () => {
				try {
					if (!content && !curContent.trim() && !attach) {
						console.error('Cannot send empty message');
						return;
					}

					const trimmedContent = curContent.trim();
					await superMan({
						mode: content ? 'editMessage' : 'postMessage',
						messID: id,
						content: trimmedContent,
						attach,
					});
					hideTextArea();
				} catch (error) {
					console.error('Error with message:', error);
					notifyGlobalError(error, 'Nepodařilo se uložit zprávu.');
				}
			},
			comment: async () => {
				await superMan({ mode: content ? 'edit' : 'post', content: curContent });
				if (!id && textArea.current) (textArea.current.innerText = ''), setCurContent('');
				setModes(prev => ({ ...prev, replies: !content && !prev.replies ? true : prev.replies, textArea: false }));
			},
		},
	};
	const textAreaBs = {
		left: { message: content ? 'Zrušit editaci' : 'Zrušit odpověď', comment: content ? 'Zrušit editaci' : 'Zrušit odpověď' },
		right: {
			message: 'Potvrdit editaci',
			comment: !id
				? emptyDiscussion && !curContent.length
					? 'Rozjeď diskuzi! Napiš komentář ...'
					: !curContent.length
					? 'Přispěj k diskuzi!'
					: 'Zveřejnit komentář'
				: content
				? 'Potvrdit editaci'
				: id
				? 'Vložit odpověď'
				: 'Vložit komentář',
		},
	};

	const insertBlueRectangle = () => {
		const selection = window.getSelection();
		if (!selection.rangeCount || selection.isCollapsed === false) return false;
		const range = selection.getRangeAt(0);
		const textNode = range.startContainer;
		if (textNode.nodeType === Node.TEXT_NODE) {
			const match = /\/\/\//.exec(textNode.textContent);
			if (match) {
				const span = document.createElement('span');
				span.className = 'blue-rectangle';
				const space = document.createTextNode(' ');

				range.setStart(textNode, match.index);
				range.setEnd(textNode, match.index + 3);
				range.deleteContents();
				range.insertNode(space);
				range.insertNode(span);

				range.setStartAfter(span);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
				return true;
			}
		}
		return false;
	};

	const getPlaceholder = () => (isChatSetup ? 'povinná první zpráva' : thisIs === 'newMessage' ? 'Napiš svou zprávu ...' : 'Zde napiš svůj komentář ...');
	const handleInput = e => {
		if (disable) return;
		if (isEmpty.current && textArea.current.innerText.length > 1) (textArea.current.innerText = textArea.current.innerText.slice(1)), (isEmpty.current = false);
		else if (isEmpty.current && textArea.current.innerText.length === 1) isEmpty.current = false;
		else if (thisIs === 'newMessage' && !e.target.innerText.trim().length) isEmpty.current = true;

		let newValue = e.target.innerText.replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
		if (isChatSetup) superMan({ mode: 'firstMessage', content: newValue });
		if (insertBlueRectangle()) e.preventDefault();
		setCurContent(newValue);
	};

	useEffect(() => {
		if (inform && Array.isArray(inform)) {
			const restoreCmd = inform.find(i => i.startsWith('restoreDraft:'));
			if (restoreCmd) {
				const contentToRestore = restoreCmd.split('restoreDraft:')[1];
				setCurContent(contentToRestore);
				if (textArea.current) textArea.current.innerText = contentToRestore;
				if (setInform) setInform(prev => prev.filter(i => i !== restoreCmd));
			}
		}
	}, [inform, setInform]);

	useEffect(() => {
		const textAreaEl = textArea.current; // CAPTURE REF FOR CLEANUP ---------------------------
		if (thisIs === 'comment' && !isMobile) textAreaEl.focus({ preventScroll: true }); // SKIP AUTOFOCUS ON MOBILE ---------------------------
		if (menuView !== 'chats') return;
		textAreaEl.innerText = curContent || '';

		// Set placeholder initially if there's no content and no id
		if (!curContent && !content && !id) {
			textAreaEl.innerText = getPlaceholder();
			textAreaEl.classList.add('phBold');
		}

		if ((content || thisIs === 'comment' || thisIs === 'message') && id && textAreaEl) {
			if (!isMobile) window.scrollTo({ top: textAreaEl.offsetTop - 100, behavior: 'smooth' }), textAreaEl.focus({ preventScroll: true }); // SKIP SCROLL+FOCUS ON MOBILE ---------------------------
			const [range, selection] = [document.createRange(), window.getSelection()];
			range.selectNodeContents(textAreaEl), range.collapse(false), selection.removeAllRanges(), selection.addRange(range);
		}

		const handleBackspace = event => {
			if (['Backspace', 'Delete'].includes(event.key)) {
				const selection = window.getSelection();
				if (!selection.rangeCount) return;
				const range = selection.getRangeAt(0);
				const parentNode = range.startContainer.parentNode;
				const parentElement = parentNode as HTMLElement | null;
				if (parentElement?.classList?.contains('blue-rectangle')) event.preventDefault(), parentElement.remove?.();
			}
		};
		if ((thisIs === 'newMessage' || id) && !isMobile) textAreaEl.focus({ preventScroll: true }), textAreaEl.innerText === getPlaceholder() && setTimeout(() => (textAreaEl.innerText = ''), 100); // SKIP AUTOFOCUS ON MOBILE ---------------------------
		textAreaEl.addEventListener('keydown', handleBackspace);
		return () => textAreaEl?.removeEventListener('keydown', handleBackspace);
	}, [menuView]);

	return (
		<text-area
			key={id || 0}
			class={` ${fadedIn.includes('TextArea') ? 'fadedIn' : ''} fadingIn  ${thisIs === 'message' ? 'bInsetBlueTop' : ''} ${
				thisIs === 'newMessage' ? 'bInsetBlueTopXs2 marBotXxxs borderTop flexRow  ' : 'flexCol  '
			} ${thisIs === 'comment' && id ? ' boRadXs bInsetBlueTopXs shaBlue border marBotL  w100' : 'w100'}  posRel   mw170  aliStretch marAuto  `}>
			{showBackButton && (
				<button onClick={() => viewSwitch('chatsList')} className='boRadXxs imw4 padHorXxxs borTop pointer h100 posRel'>
					<img src={`/icons/back.png`} alt='arrow left' />
				</button>
			)}
			<div
				id={!id && thisIs === 'comment' ? 'mainTextArea' : ''}
				ref={textArea}
				onKeyDown={e => {
					if (e.key === 'Enter' && !curContent.trim().length) e.preventDefault();
					if (e.key === 'Enter' && !isChatSetup && !e.shiftKey && curContent.length > 0) e.preventDefault(), bsActions.right[thisIs]();
				}}
				contentEditable={true}
				onFocus={() => {
					if (textArea.current.innerText === getPlaceholder()) {
						textArea.current.innerText = '';
						textArea.current.classList.remove('phBold');
					}
				}}
				onBlur={() => !content && !textArea.current.innerText.trim().length && ((textArea.current.innerText = getPlaceholder()), textArea.current.classList.add('phBold'))}
				dir='ltr'
				onInput={handleInput}
				className={`textArea lh1-2 preWrap   ${
					thisIs === 'newMessage' ? 'fs12  w100 padTopXs textLeft' : isChatSetup ? 'fs14    mih8' : !id ? 'fs12  mw140 mih12 downLittle posRel textAli  boRadXs lh1-2' : 'fsD  mih10 lh1 '
				} ${thisIs !== 'newMessage' ? (!id ? ' bor2White  noBackground padTopXs    padBotS ' : 'padTopXs  bgTrans') : 'padAllXxxs'}  boldXs textSha overAuto   w100   textAli padHorS `}
			/>

			{thisIs === 'newMessage' && (
				<button
					onClick={async () => {
						if (curContent.length > 0) {
							try {
								const result = await superMan({ mode: 'postMessage', content: curContent });
								if (result !== 'throttled' && result !== undefined) {
									textArea.current.innerText = '';
									setCurContent('');
								}
							} catch (error) {
								console.error('Failed to send message:', error);
								notifyGlobalError(error, 'Nepodařilo se odeslat zprávu.');
							}
						}
					}}
					className={` ${!curContent.length ? '' : 'bDarkGreen'} padHorXxxs tWhite imw4  fsC boldM  borTop selfStretch bHover  `}>
					<img src={`/icons/back.png`} alt='arrow left' style={{ transform: 'rotate(180deg)', filter: `brightness(${curContent.length > 0 ? 10 : 1})` }} />
				</button>
			)}

			{thisIs !== 'newMessage' && (
				<area-bs class={`${!id ? '' : ' mw60'} flexCen marAuto growAll  marAuto    w100    `}>
					{id && (
						<button className={`marAuto padVerXxs bHover fsA bDarkRed boRadXxs mw40 zinMax tWhite xBold`} onClick={bsActions.left[thisIs]}>
							{textAreaBs.left[thisIs]}
						</button>
					)}
					{!isChatSetup && (!id || (id && curContent.length > 0 && content !== curContent)) && (
						<button
							className={` marAuto ${!curContent.length ? ' arrowUp' : 'bDarkGreen'} ${
								!id ? 'hvw12 mh5  bDarkBlue bor2 shaStrong   tWhite  shaBlue    mw65 w60	  posRel   boRadXxs fs14' : 'padVerXxs tWhite fsA mw40'
							}   zinMax  bHover  textSha  boldM`}
							disabled={disable}
							onClick={async e => {
								e.stopPropagation();
								if (!curContent.length) return;
								setDisable(true);
								try {
									await bsActions.right[thisIs]();
									setCurContent('');
								} finally {
									setDisable(false);
								}
							}}>
							<blue-divider class={` hr0-5  block bInsetBlueTopXl borTop bgTrans  posAbs botCen w100     marAuto   `} />

							{textAreaBs.right[thisIs]}
						</button>
					)}
				</area-bs>
			)}
		</text-area>
	);
}

export default TextArea;
