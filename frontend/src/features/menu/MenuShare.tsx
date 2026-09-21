import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Copy, ArrowUpRight, QrCode } from "lucide-react";
import { fetchMenuLinks } from "../../api/menu";
import { Help } from "../../components/Help";
export function MenuShare({ restaurantId, published }: { restaurantId: string; published: boolean }) {
  const links = useQuery({ queryKey: ["menu-links", restaurantId], queryFn: () => fetchMenuLinks(restaurantId) });
  const [target, setTarget] = useState<"web" | "max">("web"); const [message, setMessage] = useState(""); const [qrFailed, setQrFailed] = useState(false);
  if (!published) return <div className="share-panel"><QrCode size={38} strokeWidth={1.4} /><h2>QR-код меню</h2><p className="muted">Появится после публикации меню.</p></div>;
  if (links.isPending) return <p>Загрузка…</p>;
  if (links.isError) return <div role="alert"><p>{links.error.message}</p><button onClick={() => links.refetch()}>Повторить</button></div>;
  const url = target === "max" ? links.data.max_deep_link : links.data.public_menu_url;
  const local = /localhost|127\.0\.0\.1/.test(links.data.public_menu_url);
  const qr = `/api/v1/restaurants/${restaurantId}/menu/qr?target=${target}`;
  return <><div className="workspace-title"><h2>QR-код и ссылка</h2><Help label="О QR-коде">QR ведёт на постоянную гостевую ссылку. После обновления меню его не нужно перепечатывать. Проверьте сканирование перед печатью.</Help></div><div className="qr-card">
    <div className="qr-art">{qrFailed ? <button className="button-quiet" onClick={() => setQrFailed(false)}>Повторить загрузку</button> : <img className="menu-qr" src={qr} alt="QR-код меню" onError={() => setQrFailed(true)} />}</div>
    <div className="qr-settings"><h3>Ваше меню. В один скан.</h3><label>Открывать в<select aria-label="Открывать меню в" value={target} onChange={(event) => { setTarget(event.target.value as "web" | "max"); setQrFailed(false); setMessage(""); }}><option value="web">Браузере</option><option value="max" disabled={!links.data.max_deep_link}>MAX</option></select></label>{!links.data.max_deep_link && <Help label="Почему MAX недоступен">Администратору сервиса нужно настроить бота MAX.</Help>}
    {local && target === "web" && <p className="form-error">Локальный адрес. Для печати нужен публичный домен.</p>}
    <div className="copy-field"><input aria-label="Ссылка меню" readOnly value={url ?? ""} onFocus={(event) => event.target.select()} /><button className="icon-button" aria-label="Скопировать ссылку" onClick={async () => { try { await navigator.clipboard.writeText(url ?? ""); setMessage("Скопировано"); } catch { setMessage("Выделите ссылку и скопируйте вручную"); } }}><Copy size={17} /></button></div>
    <div className="share-actions"><a className="primary-link" href={qr} download><Download size={16} />Скачать PNG</a>{url && <a href={url} target="_blank" rel="noreferrer"><ArrowUpRight size={16} />Открыть меню</a>}</div><span role="status" className="muted">{message}</span></div>
  </div></>;
}
