import { useState, useRef, useLayoutEffect } from 'react';
import axios from 'axios';
import Search from './bottomMenu/Search';
import Gallery from './bottomMenu/Gallery';
import Masonry from './Masonry';
import UserStrip from './contentStrips/UserStrip';
import EventStrip from './contentStrips/EventStrip';
import useMasonResize from '../hooks/useMasonResize';
import { notifyGlobalError } from '../hooks/useErrorsMan';

// TODO implement the note into invitations.

function Invitations({
	brain,
	obj,
	onSuccess,
	downMargin = undefined,
	mode = 'eventToUsers',
	pendingMode = false,
	selectedItems: externalSelectedItems,
	invitesTotal,
	fetchMoreUsers,
	superMan,
	showUsersOnly = false,
	galleryMode = '',
	invitesHandler,
	topPadding = false,
}: any) {
	const [selectedItems, setSelectedItems] = useState([]);
	const [inviteStatus, setInviteStatus] = useState('idle');
	const [tabMode, setTabMode] = useState();
	const [searchCat, setSearchCat] = useState(mode === 'userToEvents' ? 'events' : null);
	const [note, setNote] = useState('');
	const containerRef = useRef(null);
	const contentRef = useRef();

	// Use external selectedItems if in pending mode, otherwise use internal state
	const selItemsSrc = pendingMode || showUsersOnly ? externalSelectedItems || [] : selectedItems;

	const [numOfCols] = useMasonResize({
		wrapper: contentRef,
		brain,
		contType: mode === 'eventToUsers' ? 'userStrips' : 'eveStrips',
		deps: [selItemsSrc.length],
		contLength: selItemsSrc.length,
	});

	const isUserToEvents = mode === 'userToEvents';
	// Cap selected events to 3 for userToEvents, keep previous limits otherwise
	const itemLimit = isUserToEvents ? 3 : 20; // set higher for paying users in other modes
	const StripComp = isUserToEvents ? EventStrip : UserStrip;

	useLayoutEffect(() => {
		if (!tabMode) setSelectedItems([]);
		else if (isUserToEvents) setSearchCat('events');
	}, [isUserToEvents, tabMode]);

	async function man({ mode: actionMode, obj: item, userObj }: any) {
		item = item || userObj;
		if (pendingMode && (actionMode === 'selectUser' || actionMode === 'selectEvent')) return superMan('pendingInvite', item);
		if (actionMode === 'selectUser' || actionMode === 'selectEvent') {
			setSelectedItems(prev => {
				const alreadySelected = prev.some(selected => selected.id === item.id);
				if (alreadySelected) return prev.filter(selected => selected.id !== item.id);
				if (prev.length >= itemLimit) return prev; // block adding beyond cap, but allow deselects
				return [...prev, item];
			});
			return;
		}

		if (pendingMode) return;
		if (actionMode === 'inviteUsers' || actionMode === 'inviteToEvents') {
			if (selItemsSrc.length === 0) return;
			setInviteStatus('sending');
			try {
				await axios.post('invites', {
					mode: isUserToEvents ? 'inviteToEvents' : 'inviteUsers',
					[isUserToEvents ? 'eventIDs' : 'userIDs']: selItemsSrc.map(item => item.id),
					[isUserToEvents ? 'targetUser' : 'targetEvent']: obj?.id,
					...(note?.trim() ? { note: note.trim() } : {}),
				});
				setInviteStatus('success'), setTimeout(() => onSuccess(), 2000);
			} catch (error) {
				notifyGlobalError(error, 'Nepodařilo se odeslat pozvánky.');
				setInviteStatus('error'), setTimeout(() => setInviteStatus('idle'), 2000);
			}
		}
	}

	return (
		<invitations-container
			onClick={e => e.stopPropagation()}
			class={`w100 ${tabMode ? 'mw180' : 'mw170'} marAuto zinMaXl posRel aliCen justStart flexCol mihvh33 ${downMargin ? 'marBotXxl ' : ''} ${topPadding ? 'marTopS' : ''} `}
			ref={containerRef}>
			{!showUsersOnly && (
				<upper-wrapper class='w100 padBotXxs '>
					{isUserToEvents && itemLimit > selItemsSrc.length && (
						<>
							<span
								className='fs20 textAli   w100 
					 inlineBlock marAuto xBold marBotXs'>
								Pozvání uživatele
							</span>
							<p className='fs7 textAli mw120 marBotXxs fPadHorXs lh1-1 '>
								Níže vyber zdroj, ve kterém chceš události dohledat. Můžeš až 3 najednou. Zdroje lze také kombinovat = vybrané události &quot;přežijí&quot; v zásobníku i když v průběhu
								změníš zdroj.
							</p>
						</>
					)}
					<inner-wrapper class='w100 block posRel'>
						{tabMode && itemLimit > selItemsSrc.length && (
							<button
								onClick={() => setTabMode('')}
								className={`${
									tabMode ? 'tRed textSha fs10' : 'tDarkBlue fs10'
								} posRel  xBold borBot2 bGlassSubtle  padHorL padVerXxs  posAbs topCen  zinMaXl    sideBors marBotXxxs  marAuto `}>
								{tabMode ? `Zpět na zdroje ${isUserToEvents ? 'událostí' : 'uživatelů'}` : `${isUserToEvents ? 'Vyber zdroj události' : 'Vyber zdroj uživatelů'}`}
							</button>
						)}
						{/* {tabMode && !isUserToEvents && (
							<span className='fs13 posRel downTiny zinMaXl xBold inlineBlock  marAuto'>
								{tabMode === 'search' ? 'Koho chceš vyhledat?' : tabMode === 'gallery' ? 'Vyber kategorii galerie' : 'Ostatní'}
							</span>
						)} */}

						{!tabMode && (
							<menu-bs class={`w100 flexCen wrap marAuto gapXxxs aliStretch  zinMax  posRel `}>
								{['search', 'gallery', 'other']
									.filter(
										b =>
											(tabMode ? b === tabMode : b !== 'gallery' || brain.user.unstableObj || brain.user[isUserToEvents ? 'eveInters' : 'linkUsers'].length) ||
											(isUserToEvents && brain.user.galleryIDs.futuOwn?.length)
									)
									.map(m => (
										<button
											key={m}
											onClick={e => {
												e.stopPropagation();
												if (m === 'search' && !isUserToEvents) setSearchCat(null);
												setTabMode(prev => (prev === m ? '' : m));
											}}
											className={`   bBor  padAllS imw8   iw80   bInsetBlueTopXs2   borderTop      ${
												tabMode === m
													? 'marAuto boRadM posAbs topCen maskLowXs upTiny bgTransXs  mw40  w100 bInsetBlueTopXs fs7    zinMaXl bgTransXs padHorM      xBold '
													: 'grow boldXs fs7    posRel   '
											}`}>
											<img
												src={`/icons/${m === 'search' ? 'search' : m === 'gallery' ? (mode === 'userToEvents' ? 'event' : 'people') : 'email'}.png`}
												style={{ aspectRatio: '16/10' }}
												className={`${!tabMode || tabMode === m ? '' : 'opacityS'}`}
												alt={`${m} icon`}
											/>
											{!tabMode && <span className=' xBold'>{m === 'search' ? 'Vyhledávání' : m === 'gallery' ? 'Galerie' : 'Ostatní'}</span>}
										</button>
									))}
							</menu-bs>
						)}

						{tabMode === 'search' && (
							<div className={`${selItemsSrc.length >= itemLimit ? 'hide' : ''} mw160   block marAuto`}>
								<Search brain={brain} cat={searchCat} isInvitations={mode} superMan={man} selectedItems={selItemsSrc} obj={obj} />
							</div>
						)}

						{tabMode === 'gallery' && !showUsersOnly && (
							<div className={`${selItemsSrc.length >= itemLimit ? 'hide' : ''}`}>
								<Gallery brain={brain} superMan={man} isInvitations={mode} selectedItems={selItemsSrc} itemLimit={itemLimit} />
							</div>
						)}
					</inner-wrapper>
				</upper-wrapper>
			)}
			{selItemsSrc.length > 0 && (tabMode || showUsersOnly) && (
				<selected-wrapper ref={contentRef} class={`w100 flexCol   aliCen  justCen block `}>
					<header-wrapper class={`${!showUsersOnly ? 'marTopM' : ''} flexCol textAli justCen w100`}>
						{!showUsersOnly && (
							<span className='fs17 marBotXxs xBold inlineBlock  marAuto'>
								{isUserToEvents
									? `Vybran${selItemsSrc.length > 1 ? 'é' : 'á'} událost${selItemsSrc.length > 1 ? 'i' : ''} (${selItemsSrc.length}/${itemLimit})`
									: `Vybran${selItemsSrc.length > 1 ? 'é' : 'i'} adresáti (${selItemsSrc.length}/${itemLimit})`}
							</span>
						)}
						{!showUsersOnly && <span className='fs7 marBotXxs tRed boldS marAuto'>Pro odstranění na vybrané položky klikni</span>}
					</header-wrapper>

					<Masonry
						content={selItemsSrc.map(item => (
							<StripComp
								key={item.id}
								rightButtons={
									showUsersOnly ? (
										<invite-actions className='flexRow h100 aliStretch'>
											{Object.entries({ accept: 'surely', refuse: 'error', [galleryMode === 'invitesIn' ? 'delete' : 'cancel']: 'trash' })
												.filter(([key]) => galleryMode === 'invitesIn' || key === 'cancel')
												.map(([key, icon]) => (
													<button
														key={key}
														className='fs6 h100 ihr2-5 iwr2-5  imw4 imiw3 iw80 padAllXs borRed'
														onClick={e => (e.stopPropagation(), invitesHandler(key, item.id))}>
														<img src={`/icons/${icon}.png`} alt={key} />
													</button>
												))}
										</invite-actions>
									) : null
								}
								{...{
									brain,
									obj: item,
									isInvitations: true,
									superMan: man,
									galleryMode,
								}}
							/>
						))}
						isInvitations={true}
						config={{ contType: isUserToEvents ? 'eveStrips' : 'userStrips', numOfCols, noPadTop: true }}
						brain={brain}
					/>

					{!showUsersOnly && (
						<note-wrapper className='w100 block textAli fPadHorXxxs marTopL'>
							<label className='fs10 xBold marBotXxs inlineBlock'> Nepovinná zpráva</label>
							<blue-divider class={` hr0-3  borTop block bInsetBlueTopXl borTop bgTrans  w100  mw100   marAuto   `} />
							<textarea value={note} onChange={e => setNote(e.target.value)} placeholder='...' className='w100  boRadXs mw160 textAli marAuto block textArea padVerXs' rows={5} />
							<blue-divider class={` hr0-3  borTop block bInsetBlueTopXl borTop bgTrans  w100  mw100   marAuto   `} />
						</note-wrapper>
					)}
					{!pendingMode && (!invitesTotal || invitesTotal > selItemsSrc.length) && (
						<button
							onClick={e => {
								e.stopPropagation();
								if (showUsersOnly) fetchMoreUsers();
								else man({ mode: isUserToEvents ? 'inviteToEvents' : 'inviteUsers' });
							}}
							className={`
							${inviteStatus === 'sending' || showUsersOnly ? 'bBlue' : inviteStatus === 'success' ? 'bDarkGreen' : inviteStatus === 'error' ? 'bRed' : 'bDarkGreen'} 
							tWhite boldM fs11 padVerXs padHorS boRadXs marVerXs w100 mw100 pointer posRel marAuto
						`}
							disabled={inviteStatus === 'sending'}>
							{invitesTotal && invitesTotal > selItemsSrc.length
								? 'Načíst další...'
								: inviteStatus === 'sending'
								? 'Odesílám...'
								: inviteStatus === 'success'
								? 'Úspěšně pozváno!'
								: inviteStatus === 'error'
								? 'Chyba při odesílání'
								: isUserToEvents
								? 'Pozvat na vybrané události'
								: 'Odeslat pozvánky'}
						</button>
					)}
				</selected-wrapper>
			)}
		</invitations-container>
	);
}

export default Invitations;
