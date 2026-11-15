'use strict';

const { appendFileSync } = require('node:fs');

function parseJson(value, fallback, label) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

// CI harness paths (workflows, scripts, configs under .github/) exercise no Molecule role. An unmapped one
// selects no scenario; a caller opts it into Molecule by mapping it into a scenario filter.
function isCiInfraPath(file) {
  return file.startsWith('.github/');
}

// Returns a JSON array of scenario names, '[]' for no scenario, or '' for the full profile. An unmapped path
// never fails: it calls warn() once with its path and selects the full profile.
function selectMoleculeScenarios({ changedFiles, matchedFilters, filterOutputs, warn = () => {} }) {
  const reserved = new Set(['changed', 'contract_only', 'full_matrix']);
  const scenarios = matchedFilters.filter((name) => !reserved.has(name));
  const coveredFiles = new Set();

  for (const scenario of scenarios) {
    if (!/^[A-Za-z0-9_-]+$/.test(scenario)) {
      throw new Error(`Invalid Molecule scenario filter name: ${scenario}`);
    }
    const files = parseJson(filterOutputs[`${scenario}_files`], [], `${scenario}_files`);
    for (const file of files) coveredFiles.add(file);
  }

  if (matchedFilters.includes('contract_only')) {
    const files = parseJson(filterOutputs.contract_only_files, [], 'contract_only_files');
    for (const file of files) coveredFiles.add(file);
  }

  if (changedFiles.length === 0) return '[]';

  const uncoveredFiles = changedFiles.filter((file) => !coveredFiles.has(file));
  const fullMatrixFiles = new Set(parseJson(filterOutputs.full_matrix_files, [], 'full_matrix_files'));
  const unclassifiedFiles = uncoveredFiles.filter((file) => !fullMatrixFiles.has(file) && !isCiInfraPath(file));
  if (unclassifiedFiles.length > 0) {
    for (const file of unclassifiedFiles) warn(`unmapped path ${file}, running full profile`);
    return '';
  }
  if (scenarios.length > 0) return JSON.stringify(scenarios);
  if (matchedFilters.includes('contract_only')) return '[]';
  if (uncoveredFiles.length > 0) return '[]';
  throw new Error('Changed Molecule paths have no scenario or caller-contract mapping.');
}

if (require.main === module) {
  try {
    const scenarios = selectMoleculeScenarios({
      changedFiles: parseJson(process.env.CHANGED_FILES, [], 'CHANGED_FILES'),
      matchedFilters: parseJson(process.env.MATCHED_FILTERS, [], 'MATCHED_FILTERS'),
      filterOutputs: parseJson(process.env.FILTER_OUTPUTS, {}, 'FILTER_OUTPUTS'),
      warn: (message) => console.log(`::warning::${message}`),
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    const fullProfile = scenarios === '' ? 'full_profile=true\n' : '';
    appendFileSync(process.env.GITHUB_OUTPUT, `scenarios=${scenarios}\n${fullProfile}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { selectMoleculeScenarios };
