import { describe, expect, it } from 'vitest';
import { addDays, isoWeekday, periodBounds, previousPeriod, todayIn, isValidDate } from '../src/lib/dates.js';
import { occursOn, occurrenceIndex, occurrencesBetween, type TaskSchedule } from '../src/lib/recurrence.js';
import { centsToPoints, pointsToCents } from '../src/lib/family.js';
import { levelFor } from '../src/lib/gamification.js';

const base: TaskSchedule = { recurrence: 'daily', weekdays: [], month_day: null, start_date: '2026-11-02', end_date: null };

describe('fechas', () => {
  it('calcula día de la semana ISO', () => {
    expect(isoWeekday('2026-11-02')).toBe(1); // lunes
    expect(isoWeekday('2026-11-08')).toBe(7); // domingo
  });
  it('periodos semanales y mensuales', () => {
    expect(periodBounds('week', '2026-11-20')).toEqual({ start: '2026-11-16', end: '2026-11-22' });
    expect(periodBounds('month', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(previousPeriod('week', '2026-11-20')).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    expect(previousPeriod('month', '2026-01-15')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
  });
  it('fecha local en Madrid alrededor de medianoche', () => {
    // 23:30 UTC del 20/11 = 00:30 del 21/11 en Madrid (UTC+1)
    expect(todayIn('Europe/Madrid', new Date('2026-11-20T23:30:00Z'))).toBe('2026-11-21');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30'); // cambio de hora no afecta
  });
  it('valida fechas', () => {
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
  });
});

describe('recurrencias', () => {
  it('diaria con días concretos', () => {
    const t = { ...base, weekdays: [1, 3, 5] };
    expect(occurrencesBetween(t, '2026-11-02', '2026-11-08')).toEqual(['2026-11-02', '2026-11-04', '2026-11-06']);
  });
  it('semanal sin días usa el día de inicio', () => {
    const t: TaskSchedule = { ...base, recurrence: 'weekly', weekdays: [] };
    expect(occurrencesBetween(t, '2026-11-01', '2026-11-30')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  });
  it('mensual el día 31 cae en el último día en meses cortos', () => {
    const t: TaskSchedule = { ...base, recurrence: 'monthly', month_day: 31, start_date: '2026-01-01' };
    expect(occursOn(t, '2026-02-28')).toBe(true);
    expect(occursOn(t, '2026-04-30')).toBe(true);
    expect(occursOn(t, '2026-04-29')).toBe(false);
  });
  it('puntual solo un día y respeta inicio/fin', () => {
    const once: TaskSchedule = { ...base, recurrence: 'once', start_date: '2026-11-10' };
    expect(occurrencesBetween(once, '2026-11-01', '2026-11-30')).toEqual(['2026-11-10']);
    const ended = { ...base, end_date: '2026-11-03' };
    expect(occurrencesBetween(ended, '2026-11-01', '2026-11-05')).toEqual(['2026-11-02', '2026-11-03']);
  });
  it('índice de rotación cuenta ocurrencias previas', () => {
    const t = { ...base, weekdays: [1, 4] }; // lunes y jueves
    expect(occurrenceIndex(t, '2026-11-02')).toBe(0);
    expect(occurrenceIndex(t, '2026-11-05')).toBe(1);
    expect(occurrenceIndex(t, '2026-11-09')).toBe(2);
    expect(occurrenceIndex(base, '2026-11-12')).toBe(10);
  });
});

describe('dinero', () => {
  const fam = { rate_points: 100, rate_cents: 500 };
  it('convierte puntos a céntimos redondeando hacia abajo', () => {
    expect(pointsToCents(fam, 100)).toBe(500);
    expect(pointsToCents(fam, 103)).toBe(515);
    expect(pointsToCents({ rate_points: 3, rate_cents: 1 }, 10)).toBe(3);
  });
  it('convierte céntimos a puntos redondeando hacia arriba', () => {
    expect(centsToPoints(fam, 500)).toBe(100);
    expect(centsToPoints(fam, 501)).toBe(101);
  });
});

describe('niveles', () => {
  it('progresión cuadrática', () => {
    expect(levelFor(0).level).toBe(1);
    expect(levelFor(24).level).toBe(1);
    expect(levelFor(25).level).toBe(2);
    expect(levelFor(100)).toMatchObject({ level: 3, current: 0, needed: 125 });
  });
});
