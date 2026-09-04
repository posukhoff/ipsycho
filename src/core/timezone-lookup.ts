/**
 * Turns what a person types for "where are you" into an IANA zone: a zone name as is, or a
 * city in Russian, Ukrainian or English. Small on purpose; an unknown city gets a clear
 * refusal and the user can type the zone name instead.
 */
const CITY_ZONES: ReadonlyArray<[zone: string, names: string]> = [
  ["Europe/Kyiv", "киев київ kyiv kiev украина україна ukraine львов львів lviv одесса одеса odesa odessa харьков харків kharkiv днепр дніпро dnipro"],
  ["Europe/Warsaw", "варшава warszawa warsaw польша польща poland краков kraków krakow"],
  ["Europe/Berlin", "берлин берлін berlin германия німеччина germany мюнхен мюнхен munich münchen гамбург hamburg франкфурт frankfurt"],
  ["Europe/Vienna", "вена відень vienna wien австрия австрія austria"],
  ["Europe/Prague", "прага praha prague чехия чехія czechia"],
  ["Europe/Amsterdam", "амстердам amsterdam нидерланды нідерланди netherlands голландия"],
  ["Europe/Brussels", "брюссель brussels бельгия бельгія belgium"],
  ["Europe/Paris", "париж париж paris франция франція france"],
  ["Europe/Madrid", "мадрид madrid испания іспанія spain барселона barcelona"],
  ["Europe/Lisbon", "лиссабон лісабон lisbon lisboa португалия португалія portugal"],
  ["Europe/Rome", "рим rome roma италия італія italy милан milan milano"],
  ["Europe/Zurich", "цюрих zurich zürich швейцария швейцарія switzerland женева geneva"],
  ["Europe/London", "лондон london великобритания велика британія uk england britain"],
  ["Europe/Dublin", "дублин дублін dublin ирландия ірландія ireland"],
  ["Europe/Stockholm", "стокгольм stockholm швеция швеція sweden"],
  ["Europe/Oslo", "осло oslo норвегия норвегія norway"],
  ["Europe/Copenhagen", "копенгаген copenhagen дания данія denmark"],
  ["Europe/Helsinki", "хельсинки гельсінкі helsinki финляндия фінляндія finland"],
  ["Europe/Tallinn", "таллин таллінн tallinn эстония естонія estonia"],
  ["Europe/Riga", "рига riga латвия латвія latvia"],
  ["Europe/Vilnius", "вильнюс вільнюс vilnius литва lithuania"],
  ["Europe/Chisinau", "кишинёв кишинев кишинів chisinau молдова moldova"],
  ["Europe/Bucharest", "бухарест bucharest румыния румунія romania"],
  ["Europe/Sofia", "софия софія sofia болгария болгарія bulgaria"],
  ["Europe/Athens", "афины афіни athens греция греція greece"],
  ["Europe/Istanbul", "стамбул istanbul турция туреччина turkey türkiye анталья antalya"],
  ["Asia/Tbilisi", "тбилиси тбілісі tbilisi грузия грузія georgia батуми batumi"],
  ["Asia/Yerevan", "ереван єреван yerevan армения вірменія armenia"],
  ["Asia/Almaty", "алматы алмати almaty казахстан kazakhstan астана astana"],
  ["Asia/Tashkent", "ташкент tashkent узбекистан uzbekistan"],
  ["Asia/Dubai", "дубай dubai оаэ оае uae"],
  ["Asia/Jerusalem", "иерусалим єрусалим jerusalem израиль ізраїль israel тель-авив тель-авів tel aviv"],
  ["Asia/Bangkok", "бангкок bangkok таиланд таїланд thailand"],
  ["Asia/Singapore", "сингапур сінгапур singapore"],
  ["Asia/Tokyo", "токио токіо tokyo япония японія japan"],
  ["Australia/Sydney", "сидней сідней sydney австралия австралія australia"],
  ["America/New_York", "нью-йорк нью йорк new york nyc"],
  ["America/Chicago", "чикаго chicago"],
  ["America/Denver", "денвер denver"],
  ["America/Los_Angeles", "лос-анджелес лос анджелес los angeles сан-франциско san francisco сиэтл seattle"],
  ["America/Toronto", "торонто toronto канада canada монреаль montreal"],
  ["America/Vancouver", "ванкувер vancouver"],
  ["America/Sao_Paulo", "сан-паулу sao paulo бразилия бразилія brazil"],
  ["Europe/Moscow", "москва moscow"],
  ["Europe/Minsk", "минск мінськ minsk беларусь belarus"],
];

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The IANA zone for a typed value, or null when neither a zone nor a known city matches. */
export function resolveTimezoneInput(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/u.test(raw) && isIanaTimezone(raw)) return raw;
  const needle = raw.toLowerCase().replace(/ё/gu, "е").replace(/[\s-]+/gu, " ");
  for (const [zone, names] of CITY_ZONES) {
    if (names.split(" ").includes(needle) || names.includes(` ${needle} `) || names.startsWith(`${needle} `) || names.endsWith(` ${needle}`)) return zone;
  }
  return null;
}

/** Offered as buttons during onboarding; a city not among them is typed. */
export const TIMEZONE_SUGGESTIONS = ["Europe/Kyiv", "Europe/Warsaw", "Europe/Berlin", "Europe/London"] as const;
