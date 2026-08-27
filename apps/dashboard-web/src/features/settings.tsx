import {
  createProjectMutationOptions,
  dashboardHttpClient,
  renameProjectMutationOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../shared/lib/error-message';
import {
  modelDisplayPreferenceKey,
  resetModelDisplayPreference,
  setModelDisplayPreference,
  useModelDisplayPreferences,
} from './model-display-preferences';
import {
  configuredModelOptions,
  modelOptionValue,
  type RuntimeModelOption,
} from './model-option';
import { PushButton } from './notifications';
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

function ModelDisplayPreferencesEditor({
  snapshot,
}: {
  snapshot: BrowserSnapshot;
}) {
  const preferences = useModelDisplayPreferences();
  const models = modelOptionsFromSnapshot(snapshot);

  return (
    <section
      className={styles.section}
      aria-labelledby="settings-model-display-heading"
    >
      <h3 id="settings-model-display-heading">Model display</h3>
      <p className={styles.hint}>
        Choose compact aliases and colors for thread metadata. These stay in
        this browser.
      </p>
      <div className={styles.modelPreferences}>
        {models.map((model) => {
          const key = modelDisplayPreferenceKey(model.provider, model.model);
          const preference = preferences[key] ?? {};
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
                  onChange={(event) =>
                    setModelDisplayPreference(model.provider, model.model, {
                      ...preference,
                      alias: event.target.value,
                    })
                  }
                />
              </label>
              <label className={styles.modelColor}>
                <span className="sr-only">Color for {key}</span>
                <input
                  type="color"
                  aria-label={`Color for ${key}`}
                  value={preference.color ?? DEFAULT_MODEL_COLOR}
                  onChange={(event) =>
                    setModelDisplayPreference(model.provider, model.model, {
                      ...preference,
                      color: event.target.value,
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={
                  preference.alias === undefined &&
                  preference.color === undefined
                }
                onClick={() =>
                  resetModelDisplayPreference(model.provider, model.model)
                }
              >
                Reset
              </button>
            </div>
          );
        })}
      </div>
      {!models.length && <p className="muted">No observed models yet.</p>}
    </section>
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
