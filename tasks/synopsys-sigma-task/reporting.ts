import {SigmaIssueOccurrence} from "./ts/model/sigma-schema";
import fs from "fs";
import {logger} from "./ts/SigmaLogger";
import {IGitApi} from "azure-devops-node-api/GitApi";
import {FileDiffParams, FileDiffsCriteria} from "azure-devops-node-api/interfaces/GitInterfaces";

export const UNKNOWN_FILE = 'Unknown File'
export const COMMENT_PREFACE = '<!-- Comment managed by sigma-report-output action, do not modify! -->'

function get_line(filename: string, line_no: number): string {
    var data = fs.readFileSync(filename, 'utf8')
    var lines = data.split('\n')

    if (+line_no > lines.length) {
        throw new Error('File end reached without finding line')
    }

    return lines[+line_no]
}

export const uuidCommentOf = (issue: SigmaIssueOccurrence): string => `<!-- ${issue.uuid} -->`

export function createMessageFromIssue(issue: SigmaIssueOccurrence): string {
    const issueName = issue.summary
    const checkerNameString = issue.checker_id
    const impactString = issue.severity ? issue.severity.impact : 'Unknown'
    const cweString = issue.taxonomies?.cwe ? `, CWE-${issue.taxonomies?.cwe[0]}` : ''
    const description = issue.desc
    const remediation = issue.remediation ? issue.remediation : 'Not available'
    const remediationString = issue.remediation ? `## How to fix\r\n ${remediation}` : ''
    let suggestion = undefined

    // JC: Assume only one fix for now
    // TODO: Follow up with roadmap plans for fixes
    if (issue.fixes) {
        let fix = issue.fixes[0]

        let path = issue.filepath

        // TODO: try/catch for get_line in case file doesn't exist
        let current_line = get_line(path, fix.actions[0].location.start.line - 1)
        logger.info(`DEBUG: current_line=${current_line}`)

        suggestion = current_line.substring(0, fix.actions[0].location.start.column - 1) + fix.actions[0].contents + current_line.substring(fix.actions[0].location.end.column - 1, current_line.length)

        logger.info(`DEBUG: suggestion=${suggestion}`)
    }

    const suggestionString = suggestion ? '\n```suggestion\n' + suggestion + '\n```' : ''
    logger.info(`DEBUG: suggestionString=${suggestionString}`)

    return `${COMMENT_PREFACE}
${uuidCommentOf(issue)}
# :warning: Sigma Issue - ${issueName}
${description}

_${impactString} Impact${cweString}_ ${checkerNameString}

${remediationString}

${suggestionString}
`
}

export async function getDiffMap(git_agent: IGitApi, repo_id: string, project_id: string, pull_id: number): Promise<DiffMap> {
    const diffMap = new Map()

    let path = UNKNOWN_FILE

    //logger.info(`DEBUG: getDiffMap for repo: ${repo_id} project: ${project_id} pull: ${pull_id}`)

    let commits = await git_agent.getPullRequestCommits(repo_id, pull_id)
    if (commits) {
        for (const commit of commits) {
            let changes = await git_agent.getChanges(commit.commitId, repo_id)
            if (changes && changes.changes) {
                for (const change of changes.changes) {
                    if (change && change.item) {
                        //logger.info(`DEBUG: change id=${change.changeId} item path=${change.item.path} commitid=${change.item.commitId} url=${change.item.url} content=${change.item.content} type=${change.changeType}`)

                        let diff_criteria: FileDiffsCriteria = <FileDiffsCriteria>{}
                        diff_criteria.baseVersionCommit = change.item.commitId
                        diff_criteria.targetVersionCommit = change.item.commitId

                        let fileDiffParam = <FileDiffParams>{}
                        fileDiffParam.path = change.item.path
                        diff_criteria.fileDiffParams = [ fileDiffParam ]
                        //logger.info(`DEBUG: fileDiffParam len=${diff_criteria.fileDiffParams.length} dd=${diff_criteria.fileDiffParams}`)

                        let diffs = await git_agent.getFileDiffs(diff_criteria, project_id, repo_id)
                        for (const diff of diffs) {
                            //logger.info(`DEBUG: diff path=${diff.path}`)

                            for (const diffBlock of diff.lineDiffBlocks) {
                                //logger.info(`diff block mlineStart=${diffBlock.modifiedLineNumberStart} mlineCount=${diffBlock.modifiedLinesCount}`)
                                //logger.info(`diff block olineStart=${diffBlock.originalLineNumberStart} olineCount=${diffBlock.originalLinesCount}`)

                                if (!diffMap.has(change.item.path.substring(1))) {
                                    diffMap.set(change.item.path.substring(1), [])
                                }
                                //logger.info(`DEBUG: Added ${change.item.path.substring(1)}: ${diffBlock.modifiedLineNumberStart} to ${diffBlock.modifiedLineNumberStart + diffBlock.modifiedLinesCount}`)
                                diffMap.get(change.item.path.substring(1))?.push( { firstLine: diffBlock.modifiedLineNumberStart,
                                    lastLine: diffBlock.modifiedLineNumberStart + diffBlock.modifiedLinesCount } )
                            }
                        }
                    }
                }
            }
        }
    }

    return diffMap
}

export type DiffMap = Map<string, Hunk[]>

export interface Hunk {
    firstLine: number
    lastLine: number
}