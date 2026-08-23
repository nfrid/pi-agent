import {
  dashboardHttpClient,
  gitContextQueryOptions,
} from '@pi-dashboard/client';
import type {
  CheckoutSummary,
  ModelSelection,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from 'react-aria-components';
import { type DraftLocation, setDraftLocation, setDraftModel } from '../drafts';
import { configuredModelOptions, modelOptionValue } from '../model-option';

function modelName(
  model: ModelSelection | undefined,
  runtimes: readonly RuntimeSnapshot[],
): string {
  if (!model) return 'Agent';
  const option = configuredModelOptions(runtimes).find(
    (item) => item.provider === model.provider && item.model === model.model,
  );
  return option?.name ?? model.model;
}

function checkoutReason(checkout: CheckoutSummary): string | undefined {
  if (checkout.activeRunId) return 'Active run';
  if (checkout.status === 'preparing') return 'Preparing';
  if (checkout.status === 'merging') return 'Merging';
  if (checkout.status === 'failed') return 'Unavailable';
  if (checkout.status === 'retired') return 'Retired';
  return undefined;
}

function LocationRow({
  label,
  detail,
  disabled,
  onPress,
}: {
  label: string;
  detail?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      type="button"
      className="draft-picker-option"
      isDisabled={disabled}
      onPress={onPress}
    >
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </Button>
  );
}

export function DraftLocationPicker({
  draftId,
  location,
  projectId,
  projectRoot,
  checkouts,
  disabled,
}: {
  draftId: string;
  location: DraftLocation;
  projectId: string;
  projectRoot: string;
  checkouts: readonly CheckoutSummary[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [showBranches, setShowBranches] = useState(false);
  const context = useQuery({
    ...gitContextQueryOptions(dashboardHttpClient, projectId),
    enabled: open,
  });
  const main =
    checkouts.find(
      (checkout) => checkout.kind === 'main' && checkout.path === projectRoot,
    ) ?? checkouts.find((checkout) => checkout.kind === 'main');
  const selectedBranch =
    location.kind === 'worktree' && location.base === 'branch'
      ? location.baseRef
      : undefined;
  const choose = (next: DraftLocation) => {
    setDraftLocation(draftId, next);
    setOpen(false);
    setShowBranches(false);
    setBranchSearch('');
  };
  const branches = (context.data?.localBranches ?? []).filter((branch) =>
    branch.toLowerCase().includes(branchSearch.trim().toLowerCase()),
  );
  const summary =
    location.kind === 'current'
      ? `Current checkout · ${main?.branch ?? context.data?.branch ?? 'main'}`
      : location.kind === 'checkout'
        ? `Existing · ${checkouts.find((item) => item.id === location.checkoutId)?.branch ?? 'checkout'}`
        : `New worktree · ${location.base === 'work' ? 'current work' : location.base === 'head' ? 'HEAD' : `from ${selectedBranch ?? 'branch'}`}`;

  return (
    <div className="draft-picker draft-location-picker">
      <Button
        type="button"
        className="draft-picker-trigger"
        isDisabled={disabled}
        aria-label="Checkout location"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPress={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">▣</span>
        <span>{summary}</span>
      </Button>
      {open && (
        <div
          className="draft-picker-popover"
          role="dialog"
          aria-label="Checkout location"
        >
          <div className="draft-picker-heading">Location</div>
          <LocationRow
            label="Current checkout"
            detail={
              main?.status === 'dirty'
                ? main.changedFileCount === undefined
                  ? 'Changed checkout'
                  : `${main.changedFileCount} changed files`
                : 'No isolated worktree'
            }
            disabled={Boolean(main && checkoutReason(main))}
            onPress={() => main && choose({ kind: 'current' })}
          />
          <div className="draft-picker-section">New worktree</div>
          <LocationRow
            label="Current work"
            detail="Carry uncommitted work"
            onPress={() =>
              setDraftLocation(draftId, { kind: 'worktree', base: 'work' })
            }
          />
          <LocationRow
            label="Current HEAD"
            detail="Start from the current commit"
            onPress={() =>
              setDraftLocation(draftId, { kind: 'worktree', base: 'head' })
            }
          />
          <LocationRow
            label="Choose a branch"
            detail={selectedBranch ? `from ${selectedBranch}` : undefined}
            onPress={() => {
              setDraftLocation(draftId, { kind: 'worktree', base: 'branch' });
              setShowBranches(true);
            }}
          />
          {location.kind === 'worktree' && (
            <div className="draft-picker-subsection">
              <div className="draft-picker-section">Start from</div>
              {location.base === 'branch' && showBranches && (
                <>
                  <input
                    className="draft-picker-search"
                    aria-label="Search local branches"
                    placeholder="Search branches…"
                    value={branchSearch}
                    onChange={(event) =>
                      setBranchSearch(event.target.value.slice(0, 512))
                    }
                  />
                  <div className="draft-picker-results" role="listbox">
                    {branches.map((branch) => (
                      <LocationRow
                        key={branch}
                        label={branch}
                        onPress={() =>
                          choose({
                            kind: 'worktree',
                            base: 'branch',
                            baseRef: branch,
                          })
                        }
                      />
                    ))}
                    {!branches.length && (
                      <small>No matching local branches.</small>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="draft-picker-section">Existing checkouts</div>
          {checkouts
            .filter((checkout) => checkout.id !== main?.id)
            .map((checkout) => {
              const reason = checkoutReason(checkout);
              return (
                <LocationRow
                  key={checkout.id}
                  label={
                    checkout.branch ??
                    checkout.path.split('/').pop() ??
                    checkout.id
                  }
                  detail={
                    reason ??
                    (checkout.status === 'dirty'
                      ? checkout.changedFileCount === undefined
                        ? 'Changed checkout'
                        : `${checkout.changedFileCount} changed files`
                      : 'Ready')
                  }
                  disabled={Boolean(reason)}
                  onPress={() =>
                    choose({ kind: 'checkout', checkoutId: checkout.id })
                  }
                />
              );
            })}
          {context.error && (
            <small className="draft-picker-error">
              Git context unavailable: choose Current checkout or HEAD.
            </small>
          )}
        </div>
      )}
    </div>
  );
}

export function DraftAgentPicker({
  draftId,
  model,
  runtimes,
  disabled,
}: {
  draftId: string;
  model: ModelSelection | undefined;
  runtimes: readonly RuntimeSnapshot[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const models = configuredModelOptions(runtimes);
  const levels = [
    ...new Set([
      ...runtimes.flatMap((runtime) => runtime.thinkingLevels ?? []),
      ...(model?.thinking ? [model.thinking] : []),
    ]),
  ];
  const selectedValue = model
    ? modelOptionValue(model.provider, model.model)
    : '';
  const updateModel = (next: ModelSelection) => {
    setDraftModel(draftId, {
      ...next,
      ...(model?.thinking ? { thinking: model.thinking } : {}),
    });
  };
  return (
    <div className="draft-picker draft-agent-picker">
      <Button
        type="button"
        className="draft-picker-trigger"
        isDisabled={disabled}
        aria-label="Agent and thinking"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPress={() => setOpen((value) => !value)}
      >
        <span>{modelName(model, runtimes)}</span>
        {model?.thinking && <span> · {model.thinking}</span>}
      </Button>
      {open && (
        <div
          className="draft-picker-popover"
          role="dialog"
          aria-label="Agent and thinking"
        >
          <div className="draft-picker-heading">Agent</div>
          {models.map((item) => {
            const value = modelOptionValue(item.provider, item.model);
            return (
              <LocationRow
                key={value}
                label={item.name ?? value}
                detail={value === selectedValue ? 'Selected' : undefined}
                onPress={() =>
                  updateModel({ provider: item.provider, model: item.model })
                }
              />
            );
          })}
          {levels.length > 0 && (
            <>
              <div className="draft-picker-section">Thinking</div>
              {levels.map((level) => (
                <LocationRow
                  key={level}
                  label={level}
                  detail={model?.thinking === level ? 'Selected' : undefined}
                  disabled={!model}
                  onPress={() =>
                    model &&
                    setDraftModel(draftId, { ...model, thinking: level })
                  }
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
