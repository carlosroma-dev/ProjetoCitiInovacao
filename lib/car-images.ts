import type { Car } from "./contracts";

export function fallbackCarImage(car: Pick<Car, "name">) {
  const name = car.name.toLocaleLowerCase("pt-BR");
  if (name.includes("argo")) return "/images/fiat-argo.webp";
  if (name.includes("kwid")) return "/images/renault-kwid.webp";
  if (name.includes("polo")) return "/images/vw-polo.webp";
  if (name.includes("hb20")) return "/images/hyundai-hb20-2025.webp";
  return null;
}

const seedCredits = new Map([
  ["/images/fiat-argo.webp", { source: "Fiat Argo · Lanciatype840", href: "https://commons.wikimedia.org/wiki/File:Fiat_Argo.jpg", license: "CC BY 3.0", licenseHref: "https://creativecommons.org/licenses/by/3.0/" }],
  ["/images/renault-kwid.webp", { source: "Renault Kwid · Charles / usf1fan2", href: "https://commons.wikimedia.org/wiki/File:Renault_Kwid_1.0_Zen_(2022)_(52716172750).jpg", license: "CC BY 2.0", licenseHref: "https://creativecommons.org/licenses/by/2.0/" }],
  ["/images/vw-polo.webp", { source: "Volkswagen Polo · Rutger van der Maar", href: "https://commons.wikimedia.org/wiki/File:Volkswagen_Polo.jpg", license: "CC BY 2.0", licenseHref: "https://creativecommons.org/licenses/by/2.0/" }],
  ["/images/hyundai-hb20-2025.webp", { source: "Hyundai HB20 · Just a Man", href: "https://commons.wikimedia.org/wiki/File:Hyundai_HB20_1.6_Comfort_Plus_2025.jpg", license: "CC BY 4.0", licenseHref: "https://creativecommons.org/licenses/by/4.0/" }],
]);
const hostedSeedImage = /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/catalogo(\/images\/[a-z0-9-]+\.webp)$/i;

export function resolveSeedCarImage(imageUrl: string, catalogUrl: string | undefined): string {
  if (!catalogUrl || !seedCredits.has(imageUrl)) return imageUrl;
  const candidate = `${catalogUrl}${imageUrl}`;
  return hostedSeedImage.test(candidate) ? candidate : imageUrl;
}

export function carImageCredit(car: Pick<Car, "name">, imageUrl: string | null = fallbackCarImage(car)) {
  if (!imageUrl) return null;
  return seedCredits.get(hostedSeedImage.exec(imageUrl)?.[1] ?? imageUrl) ?? null;
}
