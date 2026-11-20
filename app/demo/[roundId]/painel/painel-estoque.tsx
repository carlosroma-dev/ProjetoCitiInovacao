import Image from "next/image";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { MAX_PRICE_CENTS, type Car, type CarStatus } from "../../../../lib/contracts";
import { carImageCredit } from "../../../../lib/car-images";
import { carPhotos, carStatus, carStatuses, money } from "./painel-data";
import { Empty, ErrorNotice, Icon } from "./painel-ui";
import styles from "./painel.module.css";

type QuickChange = { status?: CarStatus; move?: "up" | "down" };
type SaveCar = (car: Car | null, data: QuickChange | FormData) => Promise<void>;
type SaveCarForm = (car: Car | null, data: FormData) => Promise<void>;
type PendingPhoto = { file: File; preview: string };
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxPhotos = 3;
const maxPhotoBytes = 1.25 * 1024 * 1024;
const acceptedFormats = "image/jpeg,image/png,image/webp";

function resizePhoto(file: File) {
  return new Promise<File>((resolve, reject) => {
    const source = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = async () => {
      try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error();
        for (const size of [1600, 1200, 900]) {
          const ratio = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
          canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const compressed = await new Promise<Blob | null>((finish) => canvas.toBlob(finish, "image/jpeg", 0.82));
          if (compressed && compressed.size <= maxPhotoBytes) {
            resolve(new File([compressed], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }));
            return;
          }
        }
        throw new Error();
      } catch {
        reject(new Error(`Não foi possível reduzir “${file.name}”. Escolha uma foto de até 1,25 MB.`));
      } finally {
        URL.revokeObjectURL(source);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(source);
      reject(new Error(`Não foi possível ler “${file.name}”. Escolha outra foto.`));
    };
    image.src = source;
  });
}

function parsePrice(value: string) {
  const raw = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw)) return null;
  const [reais, centavos = ""] = raw.replace(/\./g, "").split(",");
  const cents = Number(reais) * 100 + Number(centavos.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_PRICE_CENTS ? cents : null;
}

function CarPicture({ src, alt = "" }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    <Image src={src} alt={alt} fill sizes="(max-width: 700px) 180px, 240px" unoptimized onError={() => setFailed(true)} />
  ) : <Icon name="car" />;
}

export function Stock({ cars, saveCar }: { cars: Car[]; saveCar: SaveCar }) {
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{ car: Car | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const editorTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const query = search.trim().toLocaleLowerCase("pt-BR");
  const carsToShow = query ? cars.filter((car) => `${car.name} ${car.model ?? ""}`.toLocaleLowerCase("pt-BR").includes(query)) : cars;

  useLayoutEffect(() => {
    const trigger = editorTrigger.current;
    if (editor || !trigger) return;
    editorTrigger.current = null;
    const target = trigger.isConnected ? trigger : searchInput.current;
    target?.focus({ preventScroll: true });
  }, [editor]);

  function openEditor(car: Car | null, trigger: HTMLButtonElement) {
    editorTrigger.current = trigger;
    setEditor({ car });
  }

  async function quickUpdate(car: Car, change: QuickChange) {
    setBusy(car.id);
    setNotice(null);
    try {
      await saveCar(car, change);
      setNotice({
        type: "success", text: change.move ? `Posição de ${car.name} atualizada.` : `Status de ${car.name} atualizado.`,
      });
    } catch (error) {
      setNotice({
        type: "error", text: error instanceof Error ? error.message : "Não foi possível alterar o veículo. Tente novamente.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveFromEditor(car: Car | null, data: FormData) {
    await saveCar(car, data);
    setNotice({ type: "success", text: car ? "Alterações salvas." : "Veículo cadastrado." });
    if (!car) setSearch("");
    setEditor(null);
  }

  return (
    <>
      <section className={styles.surface} aria-labelledby="stock-title">
        <div className={styles.stockToolbar}>
          <div><h2 id="stock-title">Veículos do catálogo</h2><p>{cars.length} {cars.length === 1 ? "veículo" : "veículos"}</p></div>
          <button className={styles.primaryButton} type="button" onClick={(event) => openEditor(null, event.currentTarget)} disabled={busy !== null}>
            <Icon name="plus" /> Cadastrar veículo
          </button>
        </div>
        <div className={styles.stockFilters}>
          {cars.length > 0 ? (
            <label className={styles.stockSearch}>
              <span className={styles.srOnly}>Buscar veículo</span>
              <input ref={searchInput} className={styles.control} type="search" value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por nome ou modelo" />
            </label>
          ) : null}
          {query && carsToShow.length > 0 ? <span>Limpe a busca para reordenar.</span> : null}
        </div>
        {notice?.type === "error" ? <ErrorNotice message={notice.text} /> : null}
        {notice?.type === "success" || busy ? (
          <p className={styles.stockNotice} role="status">{busy ? "Salvando alteração…" : notice?.text}</p>
        ) : null}
        {carsToShow.length ? (
          <table className={styles.stockTable} role="table">
            <thead role="rowgroup"><tr role="row">
              <th scope="col" role="columnheader">Veículo</th>
              <th scope="col" role="columnheader">Preço</th>
              <th scope="col" role="columnheader">Status</th>
              <th scope="col" role="columnheader">Ordem</th>
              <th scope="col" role="columnheader" className={styles.stockActionHeading}>Ações</th>
            </tr></thead>
            <tbody role="rowgroup">
              {carsToShow.map((car, index) => {
                const image = carPhotos(car)[0];
                const status = carStatus(car);
                const meta = [car.model, car.year, car.color].filter(Boolean).join(" · ");
                return (
                  <tr key={car.id} role="row" aria-busy={busy === car.id}>
                    <td className={styles.stockVehicle} role="cell">
                      <span className={styles.thumbnail}><CarPicture key={image} src={image} /></span>
                      <div><strong>{car.name}</strong>{meta ? <span>{meta}</span> : null}</div>
                    </td>
                    <td className={styles.stockPrice} role="cell">{money(car.priceCents)}</td>
                    <td className={styles.stockStatus} role="cell">
                      <select className={styles.statusSelect} data-state={status} value={status}
                        disabled={busy !== null} aria-label={`Status de ${car.name}`}
                        onChange={(event) => void quickUpdate(car, { status: event.target.value as CarStatus })}>
                        {Object.entries(carStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </td>
                    <td className={styles.stockOrder} role="cell">
                      <div>
                        <button className={styles.iconButton} type="button" disabled={busy !== null || Boolean(query) || index === 0}
                          aria-label={`Mover ${car.name} para cima`} title="Mover para cima" onClick={() => void quickUpdate(car, { move: "up" })}>
                          <Icon name="up" />
                        </button>
                        <button className={styles.iconButton} type="button" disabled={busy !== null || Boolean(query) || index === cars.length - 1}
                          aria-label={`Mover ${car.name} para baixo`} title="Mover para baixo" onClick={() => void quickUpdate(car, { move: "down" })}>
                          <Icon name="down" />
                        </button>
                      </div>
                    </td>
                    <td className={styles.stockAction} role="cell">
                      <button type="button" className={styles.secondaryButton} disabled={busy !== null}
                        aria-label={`Ver ou editar ${car.name}`} onClick={(event) => openEditor(car, event.currentTarget)}>
                        <Icon name="edit" /> Ver / editar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon="car" title={query ? "Nenhum resultado para a busca" : "Nenhum veículo cadastrado"}>
            {query ? "Tente outro nome ou modelo." : "Cadastre um veículo para começar a montar o estoque."}
          </Empty>
        )}
      </section>
      {editor ? <CarEditor car={editor.car} dismiss={() => setEditor(null)} save={saveFromEditor} /> : null}
    </>
  );
}

function CarEditor({ car, dismiss, save }: { car: Car | null; dismiss: () => void; save: SaveCarForm }) {
  const titleId = useId();
  const photoHelpId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const retainedUrls = useRef(new Set<string>());
  const mounted = useRef(false);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [replacePhotos, setReplacePhotos] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const existingPhotos = car ? carPhotos(car) : [];
  const replacing = existingPhotos.length > 0 && replacePhotos;
  const canUpload = !existingPhotos.length || replacePhotos;

  useEffect(() => {
    const element = dialog.current;
    const previews = retainedUrls.current;
    mounted.current = true;
    element?.showModal();
    return () => {
      mounted.current = false;
      element?.close();
      previews.forEach((url) => URL.revokeObjectURL(url));
      previews.clear();
    };
  }, []);

  async function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!chosen.length) return;
    if (chosen.length + photos.length > maxPhotos) {
      setPhotoError("Selecione até três fotos no total.");
      return;
    }
    setPhotoError(null);
    setReading(true);
    const errors: string[] = [];
    const added: PendingPhoto[] = [];
    try {
      for (const file of chosen) {
        if (!allowedTypes.has(file.type)) {
          errors.push(`“${file.name}” precisa estar em JPEG, PNG ou WebP.`);
          continue;
        }
        try {
          const prepared = file.size > maxPhotoBytes ? await resizePhoto(file) : file;
          if (!mounted.current) return;
          const preview = URL.createObjectURL(prepared);
          retainedUrls.current.add(preview);
          added.push({ file: prepared, preview });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Não foi possível preparar “${file.name}”.`);
        }
      }
      if (!mounted.current) return;
      setPhotos((current) => [...current, ...added]);
      if (errors.length) setPhotoError(errors.join(" "));
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  function removePhoto(preview: string) {
    URL.revokeObjectURL(preview);
    retainedUrls.current.delete(preview);
    setPhotos((current) => current.filter((photo) => photo.preview !== preview));
    setPhotoError(null);
  }

  function keepExistingPhotos() {
    photos.forEach(({ preview }) => {
      URL.revokeObjectURL(preview);
      retainedUrls.current.delete(preview);
    });
    setPhotos([]);
    setReplacePhotos(false);
    setPhotoError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || reading) return;
    setFormError(null);
    const data = new FormData(event.currentTarget);
    const price = parsePrice(String(data.get("price") ?? ""));
    if (price === null) {
      setFormError(`Informe um preço de R$ 0,00 a ${money(MAX_PRICE_CENTS)}. Use vírgula para os centavos.`);
      event.currentTarget.querySelector<HTMLInputElement>('input[name="price"]')?.focus();
      return;
    }
    for (const field of ["name", "model"]) {
      const value = String(data.get(field) ?? "").trim();
      if (!value && !(car && field === "model" && !car.model)) {
        setFormError(field === "name" ? "Informe o nome do veículo." : "Informe o modelo do veículo.");
        event.currentTarget.querySelector<HTMLInputElement>(`input[name="${field}"]`)?.focus();
        return;
      }
      if (value) data.set(field, value);
      else data.delete(field);
    }
    if (replacing && !photos.length) {
      setPhotoError("Selecione uma foto nova ou escolha manter as atuais.");
      return;
    }
    data.delete("price");
    data.set("priceCents", String(price));
    if (car && photos.length) data.set("replacePhotos", "true");
    photos.forEach(({ file }) => data.append("photos", file));
    setSaving(true);
    try {
      await save(car, data);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Não foi possível salvar o veículo.");
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialog} className={styles.editor} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!saving && !reading) dismiss(); }}>
      <div className={styles.editorHeader}>
        <h2 id={titleId}>{car ? "Editar veículo" : "Cadastrar veículo"}</h2>
        <button className={styles.iconButton} type="button" onClick={dismiss} disabled={saving || reading} aria-label="Fechar">
          <Icon name="close" />
        </button>
      </div>
      <form onSubmit={submit} aria-busy={saving || reading}>
        <fieldset className={styles.editorFields} disabled={saving || reading}>
          <label>Nome<input className={styles.control} name="name" required maxLength={120} defaultValue={car?.name} placeholder="Ex. Hyundai HB20" /></label>
          <label>Modelo<input className={styles.control} name="model" required={!car || Boolean(car.model)} maxLength={120} defaultValue={car?.model ?? ""} placeholder="Ex. Comfort 1.0" /></label>
          <label>Preço (R$)<input className={styles.control} name="price" inputMode="decimal" required maxLength={16}
            defaultValue={car ? (car.priceCents / 100).toFixed(2).replace(".", ",") : ""} placeholder="Ex. 75.990,00" /></label>
          <label>Status<select className={styles.control} name="status" defaultValue={car ? carStatus(car) : "available"}>
            {Object.entries(carStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <div className={styles.photoEditor}>
            <h3>Fotos do veículo</h3>
            <p id={photoHelpId}>Até três fotos em JPEG, PNG ou WebP. A primeira aparece no catálogo.</p>
            {!canUpload ? (
              <>
                <div className={styles.photoGrid}>
                  {existingPhotos.map((src, index) => {
                    const credit = car ? carImageCredit(car, src) : null;
                    return (
                      <figure key={src}>
                        <span className={styles.photoPreview}><CarPicture src={src} alt={`Foto ${index + 1} do veículo`} /></span>
                        {credit ? (
                          <figcaption>
                            <a href={credit.href} target="_blank" rel="noreferrer">{credit.source}</a>
                            {" · "}<a href={credit.licenseHref} target="_blank" rel="noreferrer">{credit.license}</a>
                          </figcaption>
                        ) : null}
                      </figure>
                    );
                  })}
                </div>
                <button type="button" className={styles.secondaryButton} onClick={() => setReplacePhotos(true)}>Substituir fotos</button>
              </>
            ) : (
              <>
                {photos.length ? (
                  <div className={styles.photoGrid}>
                    {photos.map(({ file, preview }) => (
                      <figure key={preview}>
                        <span className={styles.photoPreview}><CarPicture src={preview} alt={file.name} /></span>
                        <button className={styles.removePhoto} type="button" aria-label={`Remover ${file.name}`} onClick={() => removePhoto(preview)}>
                          <Icon name="close" />
                        </button>
                      </figure>
                    ))}
                  </div>
                ) : null}
                {photos.length < maxPhotos ? (
                  <label className={styles.uploadControl}>
                    <Icon name="photo" />
                    <span>{reading ? "Preparando fotos…" : "Selecionar fotos"}</span>
                    <input type="file" accept={acceptedFormats} multiple aria-describedby={photoHelpId} onChange={(event) => void addPhotos(event)} />
                  </label>
                ) : null}
                {replacing ? <button className={styles.textButton} type="button" onClick={keepExistingPhotos}>Manter fotos atuais</button> : null}
              </>
            )}
            {photoError ? <ErrorNotice message={photoError} /> : null}
          </div>
        </fieldset>
        {formError ? <ErrorNotice message={formError} /> : null}
        <div className={styles.editorActions}>
          <button className={styles.secondaryButton} type="button" onClick={dismiss} disabled={saving || reading}>Cancelar</button>
          <button className={styles.primaryButton} type="submit" disabled={saving || reading}>
            {saving ? "Salvando…" : car ? "Salvar alterações" : "Cadastrar veículo"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
