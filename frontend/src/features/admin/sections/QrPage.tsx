import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Copy, Download, ExternalLink, Printer, QrCode as QrIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchMenuLinks } from "../../../api/menu";
import type { Restaurant } from "../../../api/restaurants";
import { fetchSiteDraft } from "../../../api/site";
import { Button, Chip, EmptyState, QrCode, Skeleton } from "../../../design";
import { encodeQr } from "../../../design/qr";
import { showToast } from "../../../design/toast";
import { downloadFile, haptics, share } from "../../../max";
import { markQrSeen } from "../menu/MenuStart";

export const TENT_CAPTION = "Меню и советы в MAX";

// A6 at 300 dpi: 105 × 148 mm.
const TENT_WIDTH = 1240;
const TENT_HEIGHT = 1748;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/**
 * Table tent A6 as PNG: venue logo, name, the QR of the guest
 * link and «Меню и советы в MAX». Drawn locally; the QR carries only the guest link.
 */
export async function renderTableTent({ link, title, logoUrl }: { link: string; title: string; logoUrl: string | null }): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = TENT_WIDTH;
  canvas.height = TENT_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не умеет рисовать изображения");
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, TENT_WIDTH, TENT_HEIGHT);
  const font = "Arial, Helvetica, sans-serif";
  let y = logoUrl ? 150 : 280;
  const logo = logoUrl ? await loadImage(logoUrl) : null;
  if (logo) {
    const size = 180;
    context.save();
    context.beginPath();
    context.arc(TENT_WIDTH / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    context.clip();
    context.drawImage(logo, TENT_WIDTH / 2 - size / 2, y, size, size);
    context.restore();
    y += size + 60;
  }
  context.fillStyle = "#151821";
  context.textAlign = "center";
  context.textBaseline = "top";
  context.font = `bold 88px ${font}`;
  for (const line of wrapLines(context, title, TENT_WIDTH - 200, 2)) {
    context.fillText(line, TENT_WIDTH / 2, y);
    y += 104;
  }
  y += 40;
  const modules = encodeQr(link, { errorCorrection: "M" });
  const quiet = 4;
  const count = modules.length + quiet * 2;
  const cell = Math.floor(820 / count);
  const qrSize = cell * count;
  const left = Math.round((TENT_WIDTH - qrSize) / 2);
  context.fillStyle = "#151821";
  modules.forEach((row, rowIndex) => row.forEach((dark, colIndex) => {
    if (dark) context.fillRect(left + (colIndex + quiet) * cell, y + (rowIndex + quiet) * cell, cell, cell);
  }));
  y += qrSize + 50;
  context.font = `bold 60px ${font}`;
  context.fillText(TENT_CAPTION, TENT_WIDTH / 2, y);
  context.font = `40px ${font}`;
  context.fillStyle = "#5C6678";
  context.fillText("Наведите камеру на QR-код", TENT_WIDTH / 2, y + 90);
  return canvas.toDataURL("image/png");
}

/**
 * «QR и ссылка»: the QR of the guest link (MAX `startapp=r_<id>` or the web link),
 * copy/share, PNG download and the A6 table tent for printing. The QR never carries admin
 * rights — only the public guest link.
 */
export function QrPage({ point }: { point: Restaurant }) {
  const published = Boolean(point.current_published_version_id);
  const links = useQuery({ queryKey: ["menu-links", point.id], queryFn: () => fetchMenuLinks(point.id), enabled: published });
  const site = useQuery({ queryKey: ["site-draft", point.id], queryFn: () => fetchSiteDraft(point.id), retry: false, enabled: published });
  const [target, setTarget] = useState<"max" | "web">("max");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (published) markQrSeen(point.id);
  }, [point.id, published]);

  if (!published) {
    return (
      <EmptyState icon={<QrIcon size={28} />} title="QR появится после публикации">
        Опубликуйте меню — ссылка и QR не изменятся при следующих правках.
      </EmptyState>
    );
  }
  if (links.isPending) return <div className="qr-page"><Skeleton width={220} height={220} radius="control" /><Skeleton height={48} radius="control" /></div>;
  if (links.isError) {
    return <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Ссылка не загрузилась" action={<Button onClick={() => links.refetch()}>Повторить</Button>}>{links.error.message}</EmptyState>;
  }
  const maxLink = links.data.max_deep_link;
  const mode = maxLink ? target : "web";
  const link = mode === "max" && maxLink ? maxLink : links.data.public_menu_url;
  const title = point.venue_name && point.venue_name !== point.name ? `${point.venue_name} · ${point.name}` : point.name;
  const local = /localhost|127\.0\.0\.1/.test(link);
  const fileBase = `menu-${point.public_id}`;

  const downloadQr = async () => {
    const modules = encodeQr(link, { errorCorrection: "M" });
    const cell = 16;
    const count = modules.length + 8;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = count * cell;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#FFFFFF";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#151821";
    modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) context.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell); }));
    await downloadFile(canvas.toDataURL("image/png"), `${fileBase}-qr.png`);
    haptics.notify("success");
  };
  const downloadTent = async () => {
    setBusy(true);
    try {
      const url = await renderTableTent({ link, title, logoUrl: site.data?.config.logo_url ?? null });
      await downloadFile(url, `${fileBase}-a6.png`);
      haptics.notify("success");
      showToast("Тейбл-тент A6 готов к печати", { tone: "success" });
    } catch (error) {
      haptics.notify("error");
      showToast(error instanceof Error ? error.message : "Не удалось подготовить файл");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qr-page">
      <div className="qr-page__card">
        <div className="qr-page__code">
          <QrCode value={link} size={216} label={`QR-код меню «${title}»`} />
        </div>
        {maxLink && (
          <div className="qr-page__target" role="group" aria-label="Куда ведёт QR">
            <Chip selected={mode === "max"} onClick={() => setTarget("max")}>В MAX</Chip>
            <Chip selected={mode === "web"} onClick={() => setTarget("web")}>В браузере</Chip>
          </div>
        )}
        {!maxLink && <p className="cabinet-muted">QR ведёт в браузер: бот MAX ещё не настроен.</p>}
        <p className="qr-page__link" aria-label="Ссылка меню">{link}</p>
        {local && <p className="cabinet-error">Локальный адрес — для печати нужен публичный домен.</p>}
        <div className="qr-page__actions">
          <Button icon={<Printer size={20} />} loading={busy} onClick={downloadTent} fullWidth>Скачать для печати A6</Button>
          <div className="qr-page__secondary">
            <Button variant="secondary" icon={<Copy size={18} />} onClick={() => void share({ text: `Меню «${title}»`, link })}>Поделиться</Button>
            <Button variant="secondary" icon={<Download size={18} />} onClick={() => void downloadQr()}>PNG</Button>
          </div>
          <a className="cabinet-inline-link" href={links.data.public_menu_url} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />Открыть меню</a>
        </div>
      </div>
      <p className="cabinet-muted">Ссылка постоянная: после новых публикаций QR перепечатывать не нужно.</p>
    </div>
  );
}
