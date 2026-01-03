import { useState, useEffect } from 'react';
import MenuButtons from './stripButtonsJSX';
import SimpleProtocol from '../SimpleProtocol';

// TODO put smazat under "sprava" and create option to hide event but keep the data.

/** ----------------------------------------------------------------------------
 * CHAT MENU STRIP COMPONENT
 * Manages action menu for chats (mute, leave, block, archive, etc.)
 * Provides confirmation dialogs for critical actions.
 * -------------------------------------------------------------------------- */
const ChatMenuStrip = ({ obj = {} as any, chatMan, modes, isSearch, brain = {} as any, isChatsList, setStatus, setModes, getPunishmentStatus, curView }: any) => {
	const { type, messages, muted, members, id, ended, archived, hidden, seen } = obj,
		me = members?.find(m => String(m.id) === String(brain.user.id)),
		{ punish, active, who } = getPunishmentStatus(me) || {},
		role = me?.role,
		isAdmin = ['admin', 'VIP'].includes(role),
		[selButton, setSelButton] = useState(null),
		[inform, setInform] = useState();

	const hide = () => (setModes(p => ({ ...p, menu: false })), setSelButton(null));

	// WARN SPECIAL ROLES BEFORE LEAVING -------------------------------------
	useEffect(() => {
		if (selButton === 'opustit') {
			if (role === 'VIP') setInform('VIP leave');
			else if (role === 'admin' && obj.members.filter(m => m.role === 'admin').length === 1) setInform('Last ADMIN leave');
		} else setInform(null);
	}, [selButton, role, obj.members]);

	// MENU ACTIONS MAPPING --------------------------------------------------
	const src = {
		účastníci: !isSearch && !isChatsList ? async () => chatMan({ mode: 'getMembers', chatID: id }) : null,
		umlčet: curView === 'chats' && me?.flag !== 'del' && !ended && !archived && punish !== 'block' && !muted ? async () => (await chatMan({ mode: 'muteChat', chatID: id }), hide()) : null,
		odmlčet: muted ? async () => await chatMan({ mode: 'unmuteChat', chatID: id }) : null,
		opustit: type !== 'private' && me?.flag !== 'del' ? async () => (await chatMan({ mode: 'leaveChat', chatID: id }), hide()) : null,
		skrýt: curView === 'chats' && (!hidden || !seen) ? () => chatMan({ mode: 'hideChat', chatID: id }) : null,
		odkryt: hidden ? () => chatMan({ mode: 'unhideChat', chatID: id }) : null,
		blokovat: type === 'private' && punish !== 'block' ? async () => (await chatMan({ mode: 'blockChat', chatID: id }), hide()) : null,
		odblokuj: type === 'private' && punish === 'block' && who == brain.user.id ? async () => (await chatMan({ mode: 'unblockChat', chatID: id }), hide()) : null,
		odarchivovat: archived ? () => (chatMan({ mode: 'unarchiveChat', chatID: id }), hide()) : null,
		nastavit: (type === 'free' && role !== 'spect') || role === 'VIP' || role === 'admin' ? () => chatMan({ mode: 'launchSetup', chatID: id }) : null,
		archivovat: !archived && !ended && messages?.length > 0 ? () => (chatMan({ mode: 'archiveChat', chatID: id }), hide()) : null,
		ukončit: type !== 'private' && !ended && isAdmin ? () => (chatMan({ mode: 'endChat', chatID: id }), hide()) : null,
	};

	// CONFIRMATION TEXTS ----------------------------------------------------
	const desc = {
		opustit: (
			<>
				Opustíš skupinový chat, nebudeš upozorňován na nové zprávy. Historie ti zůstane do času opuštění. Vrátit zpět se budeš moct dle nastavení pro vstup do tohoto chatu.{' '}
				<strong>Chat najdeš v neaktivních chatech při příštím načtení Ministerry.</strong>
			</>
		),
		smazat: `Chat zůstane aktivní. Smaže chat z tvého seznamu aktivních chatů, Historie zůstává ${
			['free', 'group', 'VIP'].includes(obj.type) ? 'všem členům' : 'oběma stranám'
		}. Při další příchozí zprávě se obnoví a nebo jej budeš muset vyhledat dle jména.`,
		blokovat:
			type === 'private' && punish !== 'block'
				? 'Znemožní druhé straně zasílání zpráv. Historie zůstává oběma stranám. Můžeš si zvolit, zda-li tohoto uživatele zablokuješ napříč celou platformou.'
				: null,
		odblokovat: punish === 'block' && !active ? 'Odblokuješ druhou stranu. Historie zůstává oběma stranám.' : null,
		archivovat:
			!archived && messages?.length > 0
				? 'Přesune chat do archivovaných chatů. Smaže jej ze seznamu aktivních. Nebudeš dostávat upozornění na nové zprávy. I nadále zůstáváš členem. Historie ti zůstane. Po odcharchivování pokračuješ jako by se nic nestalo.'
				: null,
		odarchivovat: archived ? 'Vrátí chat zpět do aktivních chatů a načte poslední zprávy. Aktivuje ovládací prvky.' : null,
		umlčet: !archived && !muted ? 'Ztlumí upozornění na nové zprávy. Chat zůstává aktivní. Historie zůstává.' : null,
		ukončit:
			role === 'VIP' || (role === 'admin' && members.filter(m => m.role === 'admin').length === 1)
				? 'Ukončíš chat. Nikdo už do něj nebude moct přispívat. Historie zůstane všem. Tato akce je nevratná. Chat se přesune do tvých neaktivních chatů.'
				: type === 'group' && role === 'admin' && members.filter(m => m.role === 'admin').length > 1
				? 'Nejsi jediný admin! Pokud chceš ukončit chat, musíš nejdříve odebrat role všem ostatním administrátorům v nastavení chatu'
				: null,
	};
	const infoText =
		inform === 'VIP leave'
			? 'JSI VIP účastník! Pokud opustíš chat, typ chatu se změní na "řízený" (pokud existují admini) a nebo na "volný" bez jakékoliv moderace. Máš následující možnosti: 1) Před opuštěním chatu předat VIP roli jinému účastníkovi 2) Ujistit se, že existuje alespoň jeden admin, pokud chceš aby chatu zůstala moderace 3) ukončit chat, čímž jej zakonzervuješ a nikdo už do něj nebude moct přispívat.'
			: inform === 'Last ADMIN leave'
			? 'Jsi poslední admin! Pokud nyní odejdeš, typ chatu se změní na "volný" a bude pokračovat bez jakékoliv moderace. Máš následující možnosti: 1) Před ochodem udělit admin roli jinému účastníkovi 2) Opustit chat v jeho současném stavu s následky popsanými výše a nebo 3) ukončit chat, čímž jej zakonzervuješ a nikdo už do něj nebude moct přispívat.'
			: '';

	// RENDER ------------------------------------------------------------------
	return (
		<menu-strip>
			<MenuButtons tons {...{ src, thisIs: 'chat', selButton, setSelButton, isChatsList, modes }} />
			{selButton !== 'účastníci' && src[selButton] && (
				<confirm-div class='flexCol borTopLight bgWhite padBotS fPadHorS padTopM textAli  borBot5 shaComment  bInsetBlueTop posRel'>
					{inform && (
						<inform-message class='marBotM textAli flexCol'>
							<span className='fs17 xBold tRed marBotS marTopS  inlineBlock tSha'>Upozornění!!!</span>
							<span className='lh1 fs8 bold'>{infoText}</span>
						</inform-message>
					)}
					<span className='fsD tRed marBotXxxs marAuto w90 lh1 boldM'>{`Opravdu ${selButton}? `}</span>
					<span className='fs9 lh1 w90 marAuto marBotS'>{desc[selButton]}</span>
					<button onClick={src[selButton]} className={`bDarkRed padAllXs w80 mw50 boRadS fsA boldS tWhite marAuto`}>{`Ano, opravdu ${selButton} chat`}</button>
				</confirm-div>
			)}
			{modes.protocol && <SimpleProtocol setModes={setModes} target={obj.id} modes={modes} thisIs='message' brain={brain} setStatus={setStatus} />}
		</menu-strip>
	);
};

export default ChatMenuStrip;
