// Named scenarios for `orca plugin check`: each renders the panel once on this machine, with
// the plugin's worker on the same host and the capabilities the manifest declares. The default
// `home` scenario renders the rail as the panel would draw it live. The `detail` scenario
// appears only when the caller names a record in ORCA_TEMPER_DETAIL_ID: a bare UUID is
// machine-local — the repo carries no temper resource ids — and the scenario seeds the
// detail stack the panel persisted on a previous run, so the check renders that record's
// detail against live temper, the way-out button lit by the scenario's own setting.
import { defineCheck } from 'orca/testing'

const named = process.env['ORCA_TEMPER_DETAIL_ID']?.trim()

export default defineCheck({
  home: {},
  ...(named !== undefined && named !== ''
    ? {
        detail: {
          settings: { webUrl: 'https://temper.example' },
          persisted: {
            plugin: {
              'detail-stack': [{ id: named, ref: '', title: '', docType: '' }]
            }
          }
        }
      }
    : {})
})
