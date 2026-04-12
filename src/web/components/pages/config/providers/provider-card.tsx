import type { ConfigSchemaType } from "@core/validations/config";
import { ProviderCommonFields } from "./provider-common-fields";
import { ProviderDirectPanel } from "./provider-direct-panel";
import { ProviderNewApiPanel } from "./provider-newapi-panel";
import { ProviderNvidiaPanel } from "./provider-nvidia-panel";
import { ProviderSub2ApiPanel } from "./provider-sub2api-panel";
import { providerPath } from "./provider-path";
import {
  FormattedMessage,
  useIntl,
} from "@web/components/provider/intl-provider";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { Card } from "@web/components/ui/card";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@web/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { ChevronRightIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

interface Props {
  index: number;
  onDelete: () => void;
}

export function ProviderCard(props: Props) {
  const intl = useIntl();
  const form = useFormContext<ConfigSchemaType>();
  const type = useWatch({
    control: form.control,
    name: providerPath(props.index, "type"),
  }) as string | undefined;
  const name = useWatch({
    control: form.control,
    name: providerPath(props.index, "name"),
  }) as string | undefined;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <Card size="sm">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-4 py-3">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Expand"
                className={
                  open
                    ? "rotate-90 transition-transform"
                    : "transition-transform"
                }
              >
                <ChevronRightIcon />
              </Button>
            }
          />
          <Badge variant="outline">{type}</Badge>
          <span className="text-sm font-medium">
            {name || (
              <span className="text-muted-foreground italic">unnamed</span>
            )}
          </span>
          <div className="ml-auto">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setConfirmOpen(true)}
              aria-label="Delete"
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
        <CollapsiblePanel>
          <div className="space-y-6 border-t px-4 py-4">
            <ProviderCommonFields index={props.index} />
            <div className="border-border border-t pt-4">
              {renderTypePanel(type, props.index)}
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage(
                { id: "CONFIG.PROVIDERS.CONFIRM_DELETE" },
                { name: name ?? "" },
              )}
            </DialogTitle>
            <DialogDescription>
              <FormattedMessage id="CONFIG.PROVIDERS.CONFIRM_DELETE_DESC" />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              <FormattedMessage id="CONFIG.PROVIDERS.CANCEL" />
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                props.onDelete();
              }}
            >
              <FormattedMessage id="CONFIG.PROVIDERS.DELETE" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function renderTypePanel(type: string | undefined, index: number) {
  if (type === "newapi") return <ProviderNewApiPanel index={index} />;
  if (type === "sub2api") return <ProviderSub2ApiPanel index={index} />;
  if (type === "direct") return <ProviderDirectPanel index={index} />;
  if (type === "nvidia") return <ProviderNvidiaPanel index={index} />;
  return null;
}
