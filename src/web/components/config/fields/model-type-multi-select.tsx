import { MODEL_TYPES, type ModelType } from "@core/models/constants";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Checkbox } from "@web/components/ui/checkbox";
import type { TranslationKey } from "@web/lib/constants";

interface Props {
  value: ModelType[] | undefined;
  onChange: (value: ModelType[] | undefined) => void;
}

const MODEL_TYPE_LABEL: Record<ModelType, TranslationKey> = {
  text: "MODEL_TYPE.TEXT",
  image: "MODEL_TYPE.IMAGE",
  video: "MODEL_TYPE.VIDEO",
  audio: "MODEL_TYPE.AUDIO",
  embedding: "MODEL_TYPE.EMBEDDING",
};

/**
 * Checkbox list over MODEL_TYPES. Undefined means "use default" (text-only);
 * an empty array means "skip all testing". The UI cannot express undefined
 * directly — an outer Switch toggles whether this control renders at all.
 */
export function ModelTypeMultiSelect(props: Props) {
  const selected = new Set(props.value ?? []);

  const toggle = (type: ModelType) => {
    const next = new Set(selected);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    // Preserve MODEL_TYPES ordering for stable YAML output.
    props.onChange(MODEL_TYPES.filter((t) => next.has(t)));
  };

  return (
    <div className="flex flex-wrap gap-3">
      {MODEL_TYPES.map((type) => (
        <label key={type} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={selected.has(type)}
            onCheckedChange={() => toggle(type)}
          />
          <FormattedMessage id={MODEL_TYPE_LABEL[type]} />
        </label>
      ))}
    </div>
  );
}
