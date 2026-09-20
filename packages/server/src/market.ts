/**
 * Market-volatility feeds. Alongside chain congestion, the simulation takes a
 * 0..1 "market temperature" that drives creature excitation (faster, messier
 * movement and a higher metabolism while markets are volatile).
 */

export interface MarketSample {
  /** 0..1, higher = more volatile equities. */
  temp: number;
}

export interface MarketFeed {
  readonly name: string;
  sample(): Promise<MarketSample>;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Offline feed for local development following the US equities rhythm:
 *   - regular session (9:30-16:00 ET): high volatility, spiking at the open
 *   - pre-market (4:00-9:30) and after-hours (16:00-20:00): medium
 *   - overnight: low
 *   - weekends: near zero
 * Eastern Time is approximated as a fixed UTC-4 offset (EDT); good enough
 * for a development feed. Zero network, zero dependencies.
 */
export class SyntheticMarketFeed implements MarketFeed {
  readonly name = 'synthetic-market';

  async sample(): Promise<MarketSample> {
    const et = new Date(Date.now() - 4 * 3600_000);
    const day = et.getUTCDay(); // 0 = Sunday .. 6 = Saturday
    const mins = et.getUTCHours() * 60 + et.getUTCMinutes();
    let base: number;
    if (day === 0 || day === 6) {
      base = 0.08;
    } else if (mins >= 570 && mins < 960) {
      base = mins < 630 ? 0.85 : 0.7; // opening hour spike, then regular session
    } else if ((mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200)) {
      base = 0.4;
    } else {
      base = 0.15;
    }
    const noise = (Math.random() - 0.5) * 0.1;
    return { temp: clamp01(base + noise) };
  }
}
