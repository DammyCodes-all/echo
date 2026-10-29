import type { CardPicture, ChangeCard, PictureBucket } from "@echo/contracts";

type PictureEntry = {
  card: ChangeCard;
  bucket: PictureBucket;
  picture: CardPicture | null;
};

const BUCKET_LABEL: Record<PictureBucket, string> = {
  solid: "Solid",
  right_but_unsure: "Right but unsure",
  confident_but_wrong: "Confident but wrong",
  wrong_and_knew_it: "Wrong — and knew it",
  never_looked: "Never looked at",
};

// Distinct dusk styles per bucket; deliberately no numbers or scores anywhere.
const BUCKET_STYLES: Record<PictureBucket, string> = {
  solid: "border-dusk-pass/40 bg-dusk-pass-wash text-dusk-pass",
  right_but_unsure: "border-dusk-accent/40 bg-dusk-accent-wash text-dusk-accent-soft",
  confident_but_wrong: "border-dusk-fail/40 bg-dusk-fail-wash text-dusk-fail",
  wrong_and_knew_it: "border-dusk-peach/40 bg-dusk-peach-wash text-dusk-peach",
  never_looked: "border-dusk-hairline-strong bg-dusk-track text-dusk-muted",
};

function bucketFor(cardId: string, picture: CardPicture[]): CardPicture | null {
  return picture.find((entry) => entry.cardId === cardId) ?? null;
}

export function CheckPicture({
  cards,
  picture,
  onOpenCard,
  onDone,
}: {
  cards: ChangeCard[];
  picture: CardPicture[];
  onOpenCard: (cardId: string) => void;
  onDone: () => void;
}) {
  const entries: PictureEntry[] = cards.map((card) => {
    const found = bucketFor(card.id, picture);
    return { card, bucket: found?.bucket ?? "never_looked", picture: found };
  });

  return (
    <div className="space-y-4 rounded-dusk-card bg-dusk-surface px-6 py-5">
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
          Your understanding picture
        </p>
        <p className="mt-2 text-sm text-dusk-muted">
          Private calibration — nothing here is a grade.
        </p>
      </div>
      <ul className="space-y-2">
        {entries.map(({ card, bucket }) => {
          const gap = bucket === "confident_but_wrong" || bucket === "never_looked";
          return (
            <li
              key={card.id}
              className={`rounded-dusk-code border px-3 py-2 text-sm ${BUCKET_STYLES[bucket]}`}
            >
              <span className="font-medium">{BUCKET_LABEL[bucket]}</span>
              <span className="ml-2 text-dusk-ink">{card.headline}</span>
              {gap ? (
                <button
                  type="button"
                  onClick={() => onOpenCard(card.id)}
                  className="ml-2 text-sm underline underline-offset-4"
                >
                  Revisit
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onDone}
        className="rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent"
      >
        Done — back to inbox
      </button>
    </div>
  );
}
