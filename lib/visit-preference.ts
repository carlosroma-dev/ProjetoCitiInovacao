const localDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
});
const weekdays = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const months = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const hourNames = ["zero", "uma|um", "duas|dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze",
  "treze", "quatorze|catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove", "vinte", "vinte e uma|vinte e um",
  "vinte e duas|vinte e dois", "vinte e tres"];
const minuteNames: Record<string, number> = { quinze: 15, "um quarto": 15, meia: 30, trinta: 30, quarenta: 40, "quarenta e cinco": 45 };
const hourPattern = `(?:[0-2]?\\d|${hourNames.slice().reverse().join("|")})`;
const minutePattern = `(?:[0-5]?\\d|${Object.keys(minuteNames).reverse().join("|")})`;
const periodPattern = String.raw`(?:\s+(?:d[ae] |da parte da )?(manha|tarde|noite))?`;
const timePattern = new RegExp(String.raw`\b(?:(as|pelas)\s+)?(${hourPattern})(?:\s*[:h]\s*(${minutePattern})|\s*h(?:oras?)?(?:\s+e\s+(${minutePattern}))?|\s+e\s+(${minutePattern}))(?:\s+minutos?)?${periodPattern}\b|\b(as|pelas)\s+(${hourPattern})${periodPattern}\b|\b(${hourPattern})\s+d[ae] (manha|tarde|noite)\b`, "g");
const singleHour = new RegExp(`^${hourPattern}$`);
const weekdayPattern = new RegExp(String.raw`\b(?:(proxim[oa])\s+)?(${[...weekdays, "dom", "seg", "ter", "qua", "qui", "sex", "sab"].join("|")})\b\.?(?:[- ]feira)?(?:\s+(que vem))?\b`, "g");
const monthPattern = new RegExp(String.raw`\b(\d{1,2})(?:\s+de)?\s+(${months.join("|")})(?:\s+de\s+(\d{4}))?\b`, "g");

export type VisitPeriod = "morning" | "afternoon" | "evening" | "any";
type Mention = { value: string | null; index: number; end: number };

export function todayInSaoPaulo(now = new Date()): string {
  return localDateFormatter.format(now);
}

export function normalizeWords(text: string): string {
  return text.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function dateParts(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function lastChoice(words: string, matches: Mention[]): Mention | undefined {
  const ordered = matches.sort((left, right) => left.index - right.index);
  const last = ordered.at(-1);
  const before = ordered.at(-2);
  if (last && before && /\bou\b(?!\s+melhor\b)/.test(words.slice(before.end, last.index))) {
    return { ...last, value: null };
  }
  return last;
}

function mentionDates(words: string, today: string): Mention | undefined {
  const [year, month] = today.split("-").map(Number);
  const withinYear = (valueMonth: number, day: number, valueYear?: number) => {
    const date = dateParts(valueYear ?? year, valueMonth, day);
    return !valueYear && date && date < today ? dateParts(year + 1, valueMonth, day) : date;
  };
  const explicit: Mention[] = [];
  const add = (match: RegExpMatchArray, value: string | null) => {
    const index = match.index ?? 0;
    explicit.push({ value, index, end: index + match[0].length });
  };
  for (const match of words.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(match, dateParts(+match[1], +match[2], +match[3]));
  for (const match of words.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g)) {
    const givenYear = match[3] ? +match[3] + (match[3].length === 2 ? 2000 : 0) : undefined;
    add(match, withinYear(+match[2], +match[1], givenYear));
  }
  for (const match of words.matchAll(monthPattern)) add(match, withinYear(months.indexOf(match[2]) + 1, +match[1], match[3] ? +match[3] : undefined));
  for (const match of words.matchAll(/\bdia\s+(\d{1,2})(?![\d/-])\b/g)) {
    if (explicit.some(({ index, end }) => match.index >= index - 4 && match.index < end)) continue;
    const day = +match[1];
    const date = dateParts(year, month, day);
    add(match, date && date >= today ? date : dateParts(year + Number(month === 12), month % 12 + 1, day));
  }
  for (const match of words.matchAll(/\b(depois de amanha|amanha|hoje|ontem)\b/g)) {
    const offset = { "depois de amanha": 2, amanha: 1, hoje: 0, ontem: -1 };
    add(match, addDays(today, offset[match[1] as keyof typeof offset]));
  }
  const byWeekday = Array.from(words.matchAll(weekdayPattern), (match) => {
    const weekday = weekdays.findIndex((name) => name.startsWith(match[2]));
    const days = (weekday - weekdayOf(today) + 7) % 7;
    const index = match.index ?? 0;
    return { value: addDays(today, days || (match[1] || match[3] ? 7 : 0)), weekday, index, end: index + match[0].length };
  });
  const explicitDate = lastChoice(words, explicit);
  if (!explicitDate) return lastChoice(words, byWeekday);
  const nearbyDay = byWeekday.findLast(({ end }) => end <= explicitDate.index && /^\s*,?\s*$/.test(words.slice(end, explicitDate.index)));
  if (nearbyDay && explicitDate.value && weekdayOf(explicitDate.value) !== nearbyDay.weekday) return { ...explicitDate, value: null };
  return lastChoice(words, [...byWeekday.filter((day) => day !== nearbyDay), explicitDate]);
}

function periodOf(text?: string): VisitPeriod | null {
  if (text === "manha") return "morning";
  if (text === "tarde") return "afternoon";
  if (text === "noite") return "evening";
  return null;
}

function timeOf(hour: string, minute?: string, period?: VisitPeriod | null): string | null {
  let hours = /^\d+$/.test(hour) ? +hour : hourNames.findIndex((names) => names.split("|").includes(hour));
  const minutes = minute ? minuteNames[minute] ?? +minute : 0;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || !Number.isFinite(minutes)) return null;
  if ((period === "afternoon" || period === "evening") && hours >= 1 && hours <= 11) hours += 12;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function mentionTimes(words: string, allowSingleHour: boolean, period: VisitPeriod | null): Mention | undefined {
  const matches = Array.from(words.matchAll(timePattern), (match) => {
    const [, withAs, firstHour, minutesDirect, minutesHours, minutesSpoken, firstPeriod, preposition, afterAs, asPeriod, periodHour, namedPeriod] = match;
    const explicitPeriod = periodOf(firstPeriod ?? asPeriod ?? namedPeriod);
    const index = match.index ?? 0;
    const hour = firstHour ?? afterAs ?? periodHour;
    const implicitPeriod = withAs || afterAs || !/[:0]/.test(match[0].charAt(0)) && !match[0].includes(":") ? period : null;
    let value = timeOf(hour, minutesDirect ?? minutesHours ?? minutesSpoken, explicitPeriod ?? implicitPeriod);
    if (withAs === "pelas" || preposition === "pelas" || /\b(?:entre|depois (?:das|de)|antes (?:das|de)|por volta das|a partir (?:das|de))\s*$/.test(words.slice(0, index))) value = null;
    return { value, index, end: index + match[0].length };
  });
  if (/\b(?:entre|por volta|mais ou menos)\b/.test(words) && matches.length) return { ...matches[matches.length - 1], value: null };
  const single = words.replace(/[^\p{L}\d ]/gu, "").trim();
  return lastChoice(words, matches) ?? (allowSingleHour && singleHour.test(single) ? { value: timeOf(single, undefined, period), index: 0, end: words.length } : undefined);
}

export function readVisitPreference(text: string, today: string, options: { allowSingleHour: boolean; period: VisitPeriod | null; date?: string | null }) {
  const words = normalizeWords(text).replace(/\b(?:boa tarde|boa noite|bom dia)\b/g, "");
  const clauses = words.split(/\b(?:ou melhor|na verdade|corrigindo|quer dizer)\b|\n/g);
  let date: Mention | undefined;
  let time: Mention | undefined;
  let period: VisitPeriod | null = null;
  for (const clause of clauses) {
    const nextDate = mentionDates(clause, today);
    const nextPeriod = periodOf(clause.match(/\b(manha|tarde|noite)\b/g)?.at(-1));
    const priorDate = date?.value ?? options.date;
    const dateChanged = nextDate && priorDate && nextDate.value !== priorDate;
    if (dateChanged) {
      time = undefined;
      period = null;
    }
    const nextTime = mentionTimes(clause, options.allowSingleHour, nextPeriod ?? (dateChanged ? null : period ?? options.period));
    date = nextDate ?? date;
    time = nextTime ?? time;
    period = nextPeriod ?? period;
  }
  return { date: date?.value, time: time?.value, period };
}
