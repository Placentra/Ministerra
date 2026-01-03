// CAPITALIZE STRING ------------------------------------------------------------
// Steps: uppercase first character only; used for generating stable meta index key names.
export const capitalize = (str: string): string => str.charAt(0).toUpperCase() + str.slice(1);

// CALCULATE AGE FROM BIRTH DATE ------------------------------------------------
// Steps: normalize inputs to Date, compute year diff, then subtract one when birthday hasn't happened yet this year.
export function calculateAge(birth: string, today: number = Date.now()): number {
	const birthDate = new Date(birth);
	const todayDate = new Date(today);
	const age = todayDate.getFullYear() - birthDate.getFullYear();
	const birthdayNotYet = todayDate.getMonth() < birthDate.getMonth() || (todayDate.getMonth() === birthDate.getMonth() && todayDate.getDate() < birthDate.getDate());
	return birthdayNotYet ? age - 1 : age;
}

// CONVERT DATE TO MYSQL FORMAT -------------------------------------------------
// Steps: serialize as ISO, trim milliseconds, then replace `T` with space to match MySQL DATETIME convention.
export const toMySqlDateFormat = (date: Date | string): string => new Date(date).toISOString().slice(0, 19).replace('T', ' ');

// DELETE FALSY VALUES FROM OBJECT ----------------------------------------------
// Steps: walk keys, optionally recurse objects, keep non-empty values (with flags for 0/false/""), and return a new object so callers can send minimal payloads.
export function delFalsy(obj: Record<string, any>, empStrings = false, zeros = false, falses = false, recur = false): Record<string, any> {
	return Object.keys(obj).reduce((acc, key) => {
		let value = obj[key];
		if (recur && typeof value === 'object' && value !== null && !Array.isArray(value)) value = delFalsy(value, empStrings, zeros, falses, recur);
		const isValueValid =
			typeof value !== 'object'
				? value || (zeros && value === 0) || (falses && value === false) || (empStrings && value === '')
				: Array.isArray(value)
				? value.length
				: value && typeof value === 'object'
				? Object.keys(value).length || value instanceof Date
				: false;
		if (isValueValid) acc[key] = value;
		return acc;
	}, {});
}

// GET IDS STRING ---------------------------------------------------------------
// Steps: stringify IDs (or targetProp) into a SQL-safe quoted list, escaping single quotes so callers can embed into IN(...) when parameterization is not possible.
export const getIDsString = (arrOrSet: Array<any> | Set<any>, targetProp?: string): string => {
	return [...arrOrSet]
		.map(item => {
			const value = String(item[targetProp] || item).replace(/'/g, "''"); // Escape quotes ---------------------------
			return `'${value}'`;
		})
		.join(',');
};

// FAVEX TOPICS VALIDATION ------------------------------------------------------
// Single source of truth for both frontend and backend:
// - Strict topic regex
// - Content-quality heuristics (notSpecific / shortWords)

export function checkFavouriteExpertTopicsQuality({ favs = [], exps = [], shortWordMaxLength = 3 }: { favs?: string[]; exps?: string[]; shortWordMaxLength?: number } = {}): string[] {
	const combinedTopics = [...(favs || []), ...(exps || [])]
		.filter(Boolean)
		.map(t => String(t).trim())
		.filter(Boolean);
	if (!combinedTopics.length) return [];

	const issues = [];

	// NOT SPECIFIC ENOUGH ------------------------------------------------------
	// Too many single-word topics reduces matchmaking precision.
	const singleWordShare = combinedTopics.filter(topic => topic.split(/\s+/).length === 1).length / combinedTopics.length;
	if (singleWordShare > 0.5) issues.push('notSpecific');

	// TOO MANY SHORT WORDS -----------------------------------------------------
	// Penalize topics dominated by very short words.
	const totalChars = combinedTopics.join(' ').length || 1;
	const shortWordsChars = combinedTopics
		.join(' ')
		.split(/\s+/)
		.filter(word => word.length <= shortWordMaxLength)
		.join('').length;
	if (shortWordsChars / totalChars > 0.5) issues.push('shortWords');

	return issues;
}

// PASSWORD STRENGTH EVALUATOR ---
// Calculates score based on length and character diversity for visual feedback.
export function getPasswordStrengthScore(strenghtIndi: any, pass: any, current: any = 0): any {
	// PARAM NORMALIZATION ---------------------------------------------------------
	// Steps: allow call sites that only pass (strenghtIndi, pass) by providing a safe default for `current`.
	if (current == null) current = 0;
	if (strenghtIndi) return current < 3 ? 'bgRed' : current < 5 ? 'bgOrange' : current < 7 ? 'bgBlue' : 'bgGreen';
	let score = 0;
	score += pass.length >= 1 && 1;
	score += pass.length >= 3 && 1;
	score += pass.length >= 6 && 1;
	score += pass.length >= 8 && 1;
	score += /[A-Z]/.test(pass) && 1;
	score += /\d/.test(pass) && 1;
	score += /[^\w\s]/.test(pass) && 1;
	return score;
}
