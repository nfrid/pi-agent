import {
  createProjectMutationOptions,
  dashboardHttpClient,
  dashboardQueryKeys,
  renameProjectMutationOptions,
  resetModelDisplayPreferenceMutationOptions,
  settingsQueryOptions,
  updateModelDisplayPreferenceMutationOptions,
} from '@pi-dashboard/client';
import {
  type BrowserSnapshot,
  type DashboardSettings,
  MAX_MODEL_DISPLAY_ALIAS,
  type ModelDisplayPreference,
} from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { errorMessage } from '../shared/lib/error-message';
import {
  modelDisplayPreferenceKey,
  normalizeModelDisplayPreference,
  useModelDisplayPreferences,
} from './model-display-preferences';
import {
  configuredModelOptions,
  modelOptionValue,
  type RuntimeModelOption,
} from './model-option';
import { PushButton } from './notifications';
import { ProjectIcon } from './project-icon';
import styles from './settings.module.css';

export function SettingsView({ snapshot }: { snapshot: BrowserSnapshot }) {
  return (
    <section className={styles.settings}>
      <section
        className={styles.section}
        aria-labelledby="settings-alerts-heading"
      >
        <h3 id="settings-alerts-heading">Alert delivery</h3>
        <div className={styles.controls}>
          <span>Browser push</span>
          <PushButton />
        </div>
      </section>
      <ModelDisplayPreferencesEditor snapshot={snapshot} />
      <ProjectAdministration snapshot={snapshot} />
    </section>
  );
}

const DEFAULT_MODEL_COLOR = '#8be9fd';
const DRACULA_MODEL_COLORS = [
  { name: 'Purple', value: '#bd93f9' },
  { name: 'Pink', value: '#ff79c6' },
  { name: 'Cyan', value: '#8be9fd' },
  { name: 'Green', value: '#50fa7b' },
  { name: 'Orange', value: '#ffb86c' },
  { name: 'Red', value: '#ff5555' },
  { name: 'Yellow', value: '#f1fa8c' },
] as const;

function ModelDisplayPreferencesEditor({
  snapshot,
}: {
  snapshot: BrowserSnapshot;
}) {
  const preferences = useModelDisplayPreferences();
  const settingsQuery = useQuery(settingsQueryOptions(dashboardHttpClient));
  const queryClient = useQueryClient();
  const updateMutation = useMutation(
    updateModelDisplayPreferenceMutationOptions(dashboardHttpClient),
  );
  const resetMutation = useMutation(
    resetModelDisplayPreferenceMutationOptions(dashboardHttpClient),
  );
  const editSequence = useRef(0);
  const latestEditByKey = useRef(new Map<string, number>());
  const models = modelOptionsFromSnapshot(snapshot);
  const controlsDisabled = !settingsQuery.data;
  const saveModelPreference = (
    modelKey: string,
    edit?: (current: ModelDisplayPreference) => ModelDisplayPreference,
  ): void => {
    const sequence = ++editSequence.current;
    latestEditByKey.current.set(modelKey, sequence);
    void queryClient
      .cancelQueries({ queryKey: dashboardQueryKeys.settings() })
      .then(
        () => {
          const current =
            queryClient.getQueryData<DashboardSettings>(
              dashboardQueryKeys.settings(),
            ) ?? settingsQuery.data;
          if (!current || latestEditByKey.current.get(modelKey) !== sequence)
            return;
          const currentPreference = Object.hasOwn(
            current.modelDisplayPreferences,
            modelKey,
          )
            ? current.modelDisplayPreferences[modelKey]
            : {};
          const preference = edit
            ? normalizeModelDisplayPreference(edit(currentPreference))
            : undefined;
          const nextPreferences = { ...current.modelDisplayPreferences };
          if (preference) {
            Object.defineProperty(nextPreferences, modelKey, {
              configurable: true,
              enumerable: true,
              value: preference,
              writable: true,
            });
          } else delete nextPreferences[modelKey];
          queryClient.setQueryData(dashboardQueryKeys.settings(), {
            ...current,
            modelDisplayPreferences: nextPreferences,
          });
          const request = preference
            ? updateMutation.mutateAsync({ modelKey, preference })
            : resetMutation.mutateAsync({ modelKey });
          void request
            .then((saved) => {
              if (latestEditByKey.current.get(modelKey) !== sequence) return;
              if (editSequence.current === sequence) {
                queryClient.setQueryData(dashboardQueryKeys.settings(), saved);
                return;
              }
              queryClient.setQueryData(
                dashboardQueryKeys.settings(),
                (latest: DashboardSettings | undefined) => {
                  if (!latest) return latest;
                  const latestPreferences = {
                    ...latest.modelDisplayPreferences,
                  };
                  if (Object.hasOwn(saved.modelDisplayPreferences, modelKey)) {
                    Object.defineProperty(latestPreferences, modelKey, {
                      configurable: true,
                      enumerable: true,
                      value: saved.modelDisplayPreferences[modelKey],
                      writable: true,
                    });
                  } else delete latestPreferences[modelKey];
                  return {
                    ...latest,
                    modelDisplayPreferences: latestPreferences,
                  };
                },
              );
            })
            .catch(() => undefined)
            .finally(() => {
              if (latestEditByKey.current.get(modelKey) === sequence)
                void queryClient.invalidateQueries({
                  queryKey: dashboardQueryKeys.settings(),
                });
            });
        },
        () => {
          if (latestEditByKey.current.get(modelKey) === sequence)
            void queryClient.invalidateQueries({
              queryKey: dashboardQueryKeys.settings(),
            });
        },
      );
  };
  const savePreferences = (
    modelKey: string,
    edit: (current: ModelDisplayPreference) => ModelDisplayPreference,
  ): void => saveModelPreference(modelKey, edit);

  return (
    <details
      className={`${styles.section} ${styles.disclosure}`}
      aria-labelledby="settings-model-display-heading"
    >
      <summary id="settings-model-display-heading">
        <span className={styles.disclosureTitle}>Model display</span>
        <small className={styles.disclosureSummary}>Aliases and colors</small>
      </summary>
      <p className={styles.hint}>
        Choose compact aliases and colors for thread metadata. These settings
        are shared across connected devices.
      </p>
      {(updateMutation.isError || resetMutation.isError) && (
        <small role="alert">Could not save model display settings.</small>
      )}
      <div className={styles.modelPreferences}>
        {models.map((model) => {
          const key = modelDisplayPreferenceKey(model.provider, model.model);
          const preference = Object.hasOwn(preferences, key)
            ? preferences[key]
            : {};
          const selectedColor = preference.color ?? DEFAULT_MODEL_COLOR;
          const setColor = (color: string) =>
            savePreferences(key, (current) => ({ ...current, color }));
          return (
            <div className={styles.modelPreference} key={key}>
              <span className={styles.modelPreferenceId} title={key}>
                {model.name ?? model.model}
                <small>{model.provider}</small>
              </span>
              <label className={styles.modelAlias}>
                <span className="sr-only">Alias for {key}</span>
                <input
                  aria-label={`Alias for ${key}`}
                  value={preference.alias ?? ''}
                  placeholder={model.model}
                  maxLength={MAX_MODEL_DISPLAY_ALIAS}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    const alias = event.currentTarget.value.slice(
                      0,
                      MAX_MODEL_DISPLAY_ALIAS,
                    );
                    savePreferences(key, (current) => ({
                      ...current,
                      ...(alias ? { alias } : { alias: undefined }),
                    }));
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={
                  controlsDisabled ||
                  (preference.alias === undefined &&
                    preference.color === undefined)
                }
                onClick={() => saveModelPreference(key)}
              >
                Reset
              </button>
              <fieldset className={styles.modelColorControls}>
                <legend className="sr-only">Colors for {key}</legend>
                {DRACULA_MODEL_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className={styles.modelColorPreset}
                    style={{ backgroundColor: color.value }}
                    aria-label={`Use ${color.name} for ${key}`}
                    aria-pressed={selectedColor === color.value}
                    title={color.name}
                    disabled={controlsDisabled}
                    onClick={() => setColor(color.value)}
                  />
                ))}
                <label className={styles.modelColor}>
                  <span className="sr-only">Custom color for {key}</span>
                  <input
                    type="color"
                    aria-label={`Custom color for ${key}`}
                    value={selectedColor}
                    disabled={controlsDisabled}
                    onChange={(event) => setColor(event.target.value)}
                  />
                </label>
              </fieldset>
            </div>
          );
        })}
      </div>
      {!models.length && <p className="muted">No observed models yet.</p>}
    </details>
  );
}

function modelOptionsFromSnapshot(
  snapshot: BrowserSnapshot,
): readonly RuntimeModelOption[] {
  const observed = (snapshot.runtimes ?? []).flatMap((runtime) =>
    runtime.model
      ? [{ provider: runtime.model.provider, model: runtime.model.model }]
      : [],
  );
  return [
    ...new Map(
      [...configuredModelOptions(snapshot.runtimes ?? []), ...observed].map(
        (model) => [modelOptionValue(model.provider, model.model), model],
      ),
    ).values(),
  ];
}

function ProjectAdministration({ snapshot }: { snapshot: BrowserSnapshot }) {
  const projects = (snapshot.projects ?? []).filter(
    (project) => project.status === 'active',
  );
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [title, setTitle] = useState('');
  const createMutation = useMutation(
    createProjectMutationOptions(dashboardHttpClient),
  );
  const renameMutation = useMutation(
    renameProjectMutationOptions(dashboardHttpClient),
  );

  const addProject = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = rootPath.trim();
    if (
      !candidate.startsWith('/') &&
      candidate !== '~' &&
      !candidate.startsWith('~/')
    ) {
      setError('Use an absolute path or ~/.');
      return;
    }
    setError(undefined);
    try {
      await createMutation.mutateAsync({ rootPath: candidate });
      setRootPath('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const rename = async (event: FormEvent, projectId: string) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || renameMutation.isPending) return;
    setError(undefined);
    try {
      await renameMutation.mutateAsync({
        projectId,
        command: { title: nextTitle },
      });
      setRenamingId(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="settings-projects-heading"
    >
      <h3 id="settings-projects-heading">Projects</h3>
      <form
        className={styles.addForm}
        onSubmit={(event) => void addProject(event)}
      >
        <label className="sr-only" htmlFor="settings-project-root">
          Project path
        </label>
        <input
          id="settings-project-root"
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          placeholder="~/code/project"
          autoComplete="off"
          disabled={createMutation.isPending}
        />
        <button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Adding…' : 'Add'}
        </button>
      </form>
      <div className={styles.projects}>
        {projects.map((project) =>
          renamingId === project.id ? (
            <form
              className={styles.projectRow}
              key={project.id}
              onSubmit={(event) => void rename(event, project.id)}
            >
              <input
                aria-label={`Rename ${project.title}`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={renameMutation.isPending}
              />
              <button type="submit" disabled={renameMutation.isPending}>
                Save
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setRenamingId(undefined)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className={styles.projectRow} key={project.id}>
              <ProjectIcon
                projectId={project.id}
                title={project.title}
                size="small"
              />
              <span>
                <strong>{project.title}</strong>
                <small>{project.rootPath}</small>
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setTitle(project.title);
                  setRenamingId(project.id);
                }}
              >
                Rename
              </button>
            </div>
          ),
        )}
      </div>
      {!projects.length && <p className="muted">No projects yet.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
