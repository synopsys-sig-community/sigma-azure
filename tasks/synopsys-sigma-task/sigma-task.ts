import * as task from 'azure-pipelines-task-lib/task'
import * as azdev from "azure-devops-node-api"
import * as ga from "azure-devops-node-api/GitApi";
import fileSystem from 'fs'
import {TaskResult} from 'azure-pipelines-task-lib'
import fs from "fs";
import {IGitApi} from "azure-devops-node-api/GitApi";
import {FileDiffParams, FileDiffsCriteria, Comment} from "azure-devops-node-api/interfaces/GitInterfaces"

import {SigmaAzureConstants} from "./ts/SigmaAzureConstants";
import {PathResolver} from "./ts/PathResolver";
import {
    sigmaCreateMessageFromIssue,
    azCreateReviewComment,
    azGetDiffMap,
    azGetExistingReviewThreads,
    sigmaIsInDiff,
    logger,
    SigmaIssuesView,
    sigmaUuidCommentOf, azUpdateComment
} from "@jcroall/synopsys-sig-node/lib";

async function run() {
    logger.info('Starting Sigma Task')
    try {
        const SYSTEM_ACCESSTOKEN = process.env['SYSTEM_ACCESSTOKEN']
        const SYSTEM_COLLECTIONURI = process.env['SYSTEM_COLLECTIONURI']
        const SYSTEM_PULLREQUEST_PULLREQUESTID = process.env['SYSTEM_PULLREQUEST_PULLREQUESTID']
        const SYSTEM_TEAMPROJECT = process.env['SYSTEM_TEAMPROJECT']
        const SYSTEM_TEAMPROJECTID = process.env['SYSTEM_TEAMPROJECTID']
        const BUILD_REPOSITORY_ID = process.env['BUILD_REPOSITORY_ID']
        const BUILD_SOURCEBRANCH = process.env['BUILD_SOURCEBRANCH']

        let pull_id = 0
        let is_pull_request = false

        if (!SYSTEM_ACCESSTOKEN || !SYSTEM_COLLECTIONURI || !SYSTEM_TEAMPROJECT || !SYSTEM_TEAMPROJECTID ||
            !BUILD_REPOSITORY_ID) {
            task.setResult(task.TaskResult.Failed, `Must specify SYSTEM_ACCESSTOKEN, SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECT, SYSTEM_TEAMPROJECTID and BUILD_REPOSITORY_ID.`, true)
            return
        }

        if (SYSTEM_PULLREQUEST_PULLREQUESTID) {
            is_pull_request = true
            pull_id = parseInt(SYSTEM_PULLREQUEST_PULLREQUESTID, 10)
        }

        let orgUrl = "https://dev.azure.com/yourorgname";

        logger.info(`Connecting to Azure DevOps: ${SYSTEM_COLLECTIONURI}`)
        let authHandler = azdev.getPersonalAccessTokenHandler(SYSTEM_ACCESSTOKEN ? SYSTEM_ACCESSTOKEN : '')
        let connection = new azdev.WebApi(SYSTEM_COLLECTIONURI ? SYSTEM_COLLECTIONURI : '', authHandler)
        let git_agent: ga.IGitApi = await connection.getGitApi()

        let git_threads = undefined

        if (is_pull_request) {
            git_threads = await azGetExistingReviewThreads(git_agent, BUILD_REPOSITORY_ID, pull_id)
            //logger.info(`DEBUG: Got PR threads`)
        }

        const sigma_results_file: string = task.getInput(SigmaAzureConstants.SIGMA_RESULTS_FILE, false) || ''

        const jsonContent = fs.readFileSync(sigma_results_file)
        const sigmaIssues = JSON.parse(jsonContent.toString()) as SigmaIssuesView

        let diff_map = undefined
        if (is_pull_request) {
            //logger.info(`DEBUG: Build diff map`)
            diff_map = await azGetDiffMap(git_agent, BUILD_REPOSITORY_ID, SYSTEM_TEAMPROJECT, pull_id)
        }

        for (const issue of sigmaIssues.issues.issues) {
            // Azure paths begin with /
            issue.filepath = issue.filepath

            logger.info(`Found Sigma Issue ${issue.uuid} at ${issue.filepath}:${issue.location.start.line}`)

            if (is_pull_request) {
                if (diff_map && !sigmaIsInDiff(issue, diff_map)) {
                    //logger.info(`DEBUG: Skipping issue ${issue.uuid}, not in diff map`)
                    continue
                }

                // TODO: Look for existing issue
                let issue_comment_body = sigmaCreateMessageFromIssue(issue)

                let ret = false

                try {
                    if (is_pull_request) {
                        const uuidComment = sigmaUuidCommentOf(issue)

                        let existing_thread = undefined
                        if (git_threads) {
                            for (const git_thread of git_threads) {
                                if (git_thread.comments && git_thread.comments[0].content &&
                                    git_thread.comments[0].content.includes(uuidComment) && git_thread.status == 1) {
                                    //logger.info(`DEBUG: Found existing thread: ${git_thread.id} status=${git_thread.status} lastUpdatedDate=${git_thread.lastUpdatedDate} isDeleted=${git_thread.isDeleted} threadContext.filePath=${git_thread.threadContext.filePath}`)
                                    existing_thread = git_thread
                                }
                            }

                        }

                        if (existing_thread && existing_thread.id && existing_thread.comments && existing_thread.comments[0].id) {
                            logger.info(`Updating Existing thread #${existing_thread.id}, comment #${existing_thread.comments[0].id} for ${issue.uuid}`)
                            let updated_comment: Comment = <Comment>{}
                            updated_comment.content = issue_comment_body
                            ret = await azUpdateComment(git_agent, BUILD_REPOSITORY_ID, pull_id, existing_thread.id, existing_thread.comments[0].id, issue_comment_body)
                            //await git_agent.updateComment(updated_comment, BUILD_REPOSITORY_ID, pull_id,
                            //    existing_thread.id, existing_thread.comments[0].id)
                        } else {
                            logger.info(`Creating new comment for ${issue.uuid}`)
                            ret = await azCreateReviewComment(git_agent, BUILD_REPOSITORY_ID, pull_id, issue, issue_comment_body)
                        }


                    }
                } catch (e) {
                    logger.warn(`Unable to comment on Sigma Issue ${issue.uuid} - it may not exist within the diffs for this pull request: ${e}`)
                }
            } else {
                logger.info(`Nothing to do, full analysis not supported yet.`)
            }

        }

        /*
        logger.info('Finished running detect, updating task information')
        if (additionalConfiguration.addTaskSummary) {
            logger.info('Adding task summary')
            const content = (detectResult == 0) ? 'Detect ran successfully' : `There was an issue running detect, exit code: ${detectResult}`
            addSummaryAttachment(content)
        }
        */
        task.setResult(TaskResult.Succeeded, 'Success', true)
    } catch (e) {
        task.setResult(task.TaskResult.Failed, `An unexpected error occurred: ${e}`, true)
        return
    }
}

function addSummaryAttachment(content: string) {
    const attachmentFilePath: string = Date.now().toString()
    const fullPath: string = PathResolver.combinePathSegments(__dirname, attachmentFilePath)
    fileSystem.writeFileSync(fullPath, content)
    task.addAttachment('Distributedtask.Core.Summary', 'Synopsys Sigma', fullPath)
}

run()
