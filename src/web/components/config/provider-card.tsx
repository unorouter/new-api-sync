import type { ConfigSchemaType } from "@core/config";
import { FormattedMessage, useIntl } from "@web/components/provider/intl-provider";
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
import { ProviderCommonFields } from "./provider-common-fields";
import {
  DirectPanel,
  NewApiPanel,
  NvidiaPanel,
  Sub2ApiPanel,
} from "./provider-type-panels";

type Provider = ConfigSchemaType["providers"][number];

interface Props {
  value: Provider;
  onChange: (value: Provider) => void;
  onDelete: () => void;
}

export function ProviderCard(props: Props) {
  const intl = useIntl();
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
                className={open ? "rotate-90 transition-transform" : "transition-transform"}
              >
                <ChevronRightIcon />
              </Button>
            }
          />
          <Badge variant="outline">{props.value.type}</Badge>
          <span className="text-sm font-medium">{props.value.name || <span className="text-muted-foreground italic">unnamed</span>}</span>
          <div className="ml-auto">
            <Button
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
            <ProviderCommonFields
              value={props.value}
              onChange={props.onChange}
            />
            <div className="border-border border-t pt-4">
              {renderTypePanel(props.value, props.onChange)}
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
                { name: props.value.name },
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

function renderTypePanel(
  provider: Provider,
  onChange: (next: Provider) => void,
) {
  if (provider.type === "newapi") {
    return <NewApiPanel value={provider} onChange={onChange} />;
  }
  if (provider.type === "sub2api") {
    return <Sub2ApiPanel value={provider} onChange={onChange} />;
  }
  if (provider.type === "direct") {
    return <DirectPanel value={provider} onChange={onChange} />;
  }
  return <NvidiaPanel value={provider} onChange={onChange} />;
}
