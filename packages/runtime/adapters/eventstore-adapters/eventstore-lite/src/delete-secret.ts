import getLog from './get-log'
import { AdapterPool } from './types'
import {
  EventstoreFrozenError,
  InputEvent,
  makeDeleteSecretEvent,
} from '@resolve-js/eventstore-base'

const deleteSecret = async (
  pool: AdapterPool,
  selector: string
): Promise<void> => {
  const { database, secretsTableName, escapeId, escape, eventsTableName } = pool

  const log = getLog('secretsManager:deleteSecret')
  log.debug(`removing secret from the database`)

  log.verbose(`selector: ${selector}`)
  log.verbose(`secretsTableName: ${secretsTableName}`)

  const secretsTableNameAsId = escapeId(secretsTableName)
  const currentThreadId = Math.floor(Math.random() * 256)
  const eventsTableNameAsId = escapeId(eventsTableName)
  const freezeTableNameAsString = escape(`${eventsTableName}-freeze`)

  const deleteSecretEvent: InputEvent = makeDeleteSecretEvent(selector)
  const serializedPayload = escape(JSON.stringify(deleteSecretEvent.payload))

  log.debug(`executing SQL query`)

  try {
    await database.exec(
      `BEGIN IMMEDIATE;

    SELECT ABS("CTE"."EventStoreIsFrozen") FROM (
        SELECT 0 AS "EventStoreIsFrozen"
      UNION ALL
        SELECT -9223372036854775808 AS "EventStoreIsFrozen"
        FROM "sqlite_master"
        WHERE "type" = 'table' AND 
        "name" = ${freezeTableNameAsString}
      ) CTE;

    UPDATE ${secretsTableNameAsId} SET secret = NULL
      WHERE id = ${escape(selector)};

    INSERT INTO ${eventsTableNameAsId}(
        "threadId",
        "threadCounter",
        "timestamp",
        "aggregateId",
        "aggregateVersion",
        "type",
        "payload"
      ) VALUES(
        ${+currentThreadId},
        COALESCE(
          (
            SELECT MAX("threadCounter") FROM ${eventsTableNameAsId}
            WHERE "threadId" = ${+currentThreadId}
          ) + 1,
         0
        ),
        MAX(
          CAST(strftime('%s','now') || substr(strftime('%f','now'),4) AS INTEGER),
          ${+deleteSecretEvent.timestamp}
        ),
        ${escape(deleteSecretEvent.aggregateId)},
        ${+deleteSecretEvent.aggregateVersion},
        ${escape(deleteSecretEvent.type)},
        json(CAST(${serializedPayload} AS BLOB))
      );

    COMMIT;`
    )
  } catch (error) {
    const errorMessage =
      error != null && error.message != null ? error.message : ''
    const errorCode = error != null && error.code != null ? error.code : ''

    try {
      await database.exec('ROLLBACK;')
    } catch (e) {}

    if (errorMessage === 'SQLITE_ERROR: integer overflow') {
      throw new EventstoreFrozenError()
    } else if (
      errorCode === 'SQLITE_CONSTRAINT' &&
      errorMessage.indexOf('PRIMARY') > -1
    ) {
      return await deleteSecret(pool, selector)
    } else {
      throw error
    }
  }

  log.debug(`query executed successfully`)
}

export default deleteSecret
