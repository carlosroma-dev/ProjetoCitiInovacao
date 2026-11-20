import { useMemo, useState } from "react";
import type { SellerSlot, Visit } from "../../../../lib/contracts";
import {
  dateKey, dateLabel, groupSchedule, money, monthKey, monthLabel, sortChronologically, timeLabel,
} from "./painel-data";
import { Empty, Icon } from "./painel-ui";
import styles from "./painel.module.css";

type Schedule = ReturnType<typeof groupSchedule>;
const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function Context({ visit }: { visit: Visit }) {
  return (
    <div className={styles.visitContext}>
      <dl>
        <div><dt>Vendedor</dt><dd>{visit.sellerName || "Sem atribuição"}</dd></div>
        {visit.tradeIn ? <div><dt>Veículo na troca</dt><dd>{visit.tradeIn}</dd></div> : null}
        {visit.budgetCents != null ? <div><dt>Orçamento informado</dt><dd>{money(visit.budgetCents)}</dd></div> : null}
      </dl>
      {visit.summary ? <p>{visit.summary}</p> : null}
    </div>
  );
}

export function Overview({ schedule, visits, today, highlightId, selectDate }: {
  schedule: Schedule;
  visits: Visit[];
  today: string;
  highlightId: string | null;
  selectDate: (day: string) => void;
}) {
  const day = schedule.get(today);
  const next = visits.find((visit) => Date.parse(visit.startsAt) >= Date.now());
  const highlighted = visits.find((visit) => visit.id === highlightId);

  return (
    <div className={styles.overviewLayout}>
      {highlighted ? (
        <article className={styles.highlightVisit} aria-label="Visita selecionada">
          <div className={styles.highlightHeading}>
            <span className={styles.emptyIcon}><Icon name="calendar" /></span>
            <div>
              <span className={styles.highlightLabel}>Visita selecionada</span>
              <h2>{highlighted.carName}</h2>
              <time dateTime={highlighted.startsAt}>
                {dateLabel(dateKey(highlighted.startsAt))} às {timeLabel(highlighted.startsAt)}
              </time>
            </div>
            <button className={styles.textButton} type="button" onClick={() => selectDate(dateKey(highlighted.startsAt))}>
              Ver na agenda <Icon name="right" />
            </button>
          </div>
          <Context visit={highlighted} />
        </article>
      ) : null}
      <div className={styles.overviewGrid}>
        <section className={styles.surface} aria-labelledby="daily-title">
          <div className={styles.surfaceHeading}>
            <h2 id="daily-title">Agenda de hoje</h2>
            <button className={styles.textButton} type="button" onClick={() => selectDate(today)}>
              Ver agenda <Icon name="right" />
            </button>
          </div>
          <div className={styles.dailyCounts}>
            <span><strong>{day?.reserved ?? 0}</strong> {(day?.reserved ?? 0) === 1 ? "reserva" : "reservas"}</span>
            <span><strong>{day?.free.length ?? 0}</strong> {(day?.free.length ?? 0) === 1 ? "horário livre" : "horários livres"}</span>
          </div>
          {day?.visits.length ? <VisitTable visits={day.visits} highlightId={highlightId} /> : (
            <Empty icon="calendar" title="Nenhuma visita para hoje">
              As visitas confirmadas pelo chat aparecem nesta agenda.
            </Empty>
          )}
        </section>
        <section className={styles.surface} aria-labelledby="next-title">
          <div className={styles.surfaceHeading}><h2 id="next-title">Próxima visita</h2></div>
          {next ? (
            <div className={styles.nextVisit}>
              <time dateTime={next.startsAt} className={styles.nextDate}>
                <Icon name="clock" /> {dateLabel(dateKey(next.startsAt), true)} às {timeLabel(next.startsAt)}
              </time>
              <strong>{next.carName}</strong>
              {next.id !== highlightId ? <Context visit={next} /> : null}
              <button className={styles.textButton} type="button" onClick={() => selectDate(dateKey(next.startsAt))}>
                Abrir dia na agenda <Icon name="right" />
              </button>
            </div>
          ) : (
            <Empty icon="clock" title="Nenhuma visita futura">
              Consulte a agenda para ver os horários livres.
            </Empty>
          )}
        </section>
      </div>
    </div>
  );
}

function VisitTable({ visits, highlightId }: { visits: Visit[]; highlightId: string | null }) {
  return (
    <table className={styles.visitTable}>
      <thead><tr><th scope="col">Hora</th><th scope="col">Veículo</th><th scope="col">Contexto</th></tr></thead>
      <tbody>
        {visits.map((visit) => (
          <tr key={visit.id} className={visit.id === highlightId ? styles.selectedVisitRow : undefined}>
            <td><time dateTime={visit.startsAt}>{timeLabel(visit.startsAt)}</time></td>
            <td><strong>{visit.carName}</strong><span className={styles.tableSeller}>{visit.sellerName || "Sem atribuição"}</span></td>
            <td>
              {visit.tradeIn || visit.budgetCents != null || visit.summary ? (
                <details>
                  <summary>Ver detalhes<span className={styles.srOnly}> de {visit.carName}</span></summary>
                  <Context visit={visit} />
                </details>
              ) : <span className={styles.muted}>Sem detalhes</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Agenda({ visits, slots, today, selectedDay, onSelectedDay, highlightId }: {
  visits: Visit[];
  slots: SellerSlot[];
  today: string;
  selectedDay: string;
  onSelectedDay: (day: string) => void;
  highlightId: string | null;
}) {
  const selectedMonth = selectedDay.slice(0, 7);
  const [calendarMonth, setCalendarMonth] = useState(selectedMonth);
  const [sellerId, setSellerId] = useState("");
  const sellers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of [...slots, ...visits]) {
      if (item.sellerId && item.sellerName) byId.set(item.sellerId, item.sellerName);
    }
    return [...byId].sort(([, a], [, b]) => a.localeCompare(b, "pt-BR"));
  }, [slots, visits]);
  const selectedSeller = sellers.some(([id]) => id === sellerId) ? sellerId : "";
  const schedule = useMemo(() => groupSchedule(
    selectedSeller ? visits.filter((visit) => visit.sellerId === selectedSeller) : visits,
    selectedSeller ? slots.filter((slot) => slot.sellerId === selectedSeller) : slots,
  ), [selectedSeller, slots, visits]);
  const anchor = new Date(`${calendarMonth}-01T12:00:00Z`);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const offset = anchor.getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const itemCount = Math.ceil((offset + days) / 7) * 7;
  const items = Array.from({ length: itemCount }, (_, index) => index - offset + 1);
  const activeDay = schedule.get(selectedDay);

  const timeline = useMemo(() => {
    if (!activeDay) return [];
    return [
      ...activeDay.visits.map((visit) => ({ id: visit.id, startsAt: visit.startsAt, sellerName: visit.sellerName, visit })),
      ...activeDay.free.map((slot) => ({ id: slot.id, startsAt: slot.startsAt, sellerName: slot.sellerName, visit: null })),
    ].sort(sortChronologically);
  }, [activeDay]);

  function changeMonth(amount: number) {
    const nextMonth = monthKey(new Date(Date.UTC(year, month + amount, 1)));
    setCalendarMonth(nextMonth);
    onSelectedDay(nextMonth === today.slice(0, 7) ? today : `${nextMonth}-01`);
  }

  function jumpToToday() {
    setCalendarMonth(today.slice(0, 7));
    onSelectedDay(today);
  }

  return (
    <div className={styles.agendaGrid}>
      <section className={styles.surface} aria-label="Calendário de visitas">
        <div className={styles.surfaceHeading}>
          <h2 className={styles.monthTitle} aria-live="polite">{monthLabel(calendarMonth)}</h2>
          <div className={styles.calendarControls}>
            <button className={styles.secondaryButton} type="button" onClick={jumpToToday}>Hoje</button>
            <button type="button" className={styles.iconButton} aria-label="Mês anterior" onClick={() => changeMonth(-1)}>
              <Icon name="left" />
            </button>
            <button type="button" className={styles.iconButton} aria-label="Próximo mês" onClick={() => changeMonth(1)}>
              <Icon name="right" />
            </button>
          </div>
        </div>
        {sellers.length > 0 ? (
          <label className={styles.agendaFilter}>
            <span>Vendedor</span>
            <select className={styles.control} value={selectedSeller} onChange={(event) => setSellerId(event.target.value)}>
              <option value="">Todos os vendedores</option>
              {sellers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        ) : null}
        <div className={styles.calendar}>
          {weekdays.map((name) => <span key={name} className={styles.weekday}>{name}</span>)}
          {items.map((number) => {
            if (number < 1 || number > days) return <span key={number} className={styles.blankDay} aria-hidden="true" />;
            const key = `${calendarMonth}-${String(number).padStart(2, "0")}`;
            const item = schedule.get(key);
            const reserved = item?.reserved ?? 0;
            const free = item?.free.length ?? 0;
            const label = `${dateLabel(key)}, ${reserved} ${reserved === 1 ? "reserva" : "reservas"}, ${free} ${free === 1 ? "vaga" : "vagas"}`;
            return (
              <button type="button" key={number} className={styles.calendarDay} aria-label={label}
                aria-pressed={key === selectedDay} aria-current={key === today ? "date" : undefined}
                onClick={() => onSelectedDay(key)}>
                <time dateTime={key}>{number}</time>
                <span className={styles.dayCounts} aria-hidden="true">
                  {reserved > 0 ? <span className={styles.bookedCount}>{reserved}</span> : null}
                  {free > 0 ? <span className={styles.freeCount}>{free}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className={styles.calendarLegend}>
          <span><i className={styles.bookedCount} /> Reservas</span>
          <span><i className={styles.freeCount} /> Horários livres</span>
        </div>
      </section>
      <section className={styles.surface} aria-labelledby="selected-date">
        <div className={styles.surfaceHeading}>
          <div>
            <h2 id="selected-date" aria-live="polite">{dateLabel(selectedDay)}</h2>
            <p>Horário de Brasília</p>
          </div>
        </div>
        {timeline.length ? (
          <ul className={styles.timeline}>
            {timeline.map(({ visit, id, startsAt, sellerName }) => (
              <li key={id} className={visit?.id === highlightId ? styles.selectedVisitRow : undefined}>
                <time dateTime={startsAt}>{timeLabel(startsAt)}</time>
                {visit ? (
                  <div>
                    <span className={`${styles.stateTag} ${styles.bookedCount}`}>Reservado</span>
                    <strong>{visit.carName}</strong>
                    <Context visit={visit} />
                  </div>
                ) : <div className={styles.freeSlot}>
                  <span className={`${styles.stateTag} ${styles.freeCount}`}>Livre</span>
                  <span>{sellerName || "Sem atribuição"}</span>
                </div>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="calendar" title="Nenhum horário para este dia">
            Selecione outro dia para consultar a agenda.
          </Empty>
        )}
      </section>
    </div>
  );
}
