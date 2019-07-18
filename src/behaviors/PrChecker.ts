import moment from 'moment';
import {
  WebhookPayloadCheckRun,
  WebhookPayloadCheckRunCheckRun,
  WebhookPayloadPullRequest,
  WebhookPayloadPullRequestReview,
} from '@octokit/webhooks';
import { PullsListReviewsResponseItem } from '@octokit/rest';
import { Application, Context } from 'probot';
import { GitHubAPI } from 'probot/lib/github';
import { Behavior } from '../types/generics';
import { checkResponseStatus, checkResponseWith } from '../utils/OctokitUtils';
import { getOrQueryPrsForCommit } from '../utils/PrQueries';

interface ReviewStatuses {
  [key: string]: string;
}

export default class PrChecker extends Behavior {
  private static LOG_FIELDS = { behavior: 'PrChecker' };
  private static CHECK_NAME = 'Kiali - PR';

  public constructor(app: Application) {
    super(app);

    // Events that should trigger the checks
    app.on('pull_request.opened', this.pullRequestEventHandler);
    app.on('pull_request.reopened', this.pullRequestEventHandler);
    app.on('check_run.rerequested', this.checkRerequestedHandler);
    app.on('pull_request_review.dismissed', this.pullRequestReviewEventHandler);
    app.on('pull_request_review.submitted', this.pullRequestReviewEventHandler);

    // Listen when checks are OK to run
    app.on('check_run.created', this.doChecks);

    app.log.info('PrChecker behavior is initialized');
  }

  private checkRerequestedHandler = async (context: Context<WebhookPayloadCheckRun>): Promise<void> => {
    // Proceed only if the app owns the check and is a check of the current behavior
    if (!this.isOwnedCheckRun(context.payload.check_run)) {
      return;
    }

    this.app.log.debug(PrChecker.LOG_FIELDS, 'Queuing new PR checks (check run re-requested)');
    this.createCheckRun(context.github, context.repo({ head_sha: context.payload.check_run.head_sha }));
  };

  private pullRequestEventHandler = async (context: Context<WebhookPayloadPullRequest>): Promise<void> => {
    this.app.log.debug(PrChecker.LOG_FIELDS, `Queuing new PR checks (PR ${context.payload.pull_request.number})`);
    this.createCheckRun(context.github, context.repo({ head_sha: context.payload.pull_request.head.sha }));
  };

  private pullRequestReviewEventHandler = async (context: Context<WebhookPayloadPullRequestReview>): Promise<void> => {
    const logFields = { pr_number: context.payload.pull_request.number, ...PrChecker.LOG_FIELDS };

    // If submitted review is approved and user is from required users list, just
    // mark checks as successful.
    if (
      (context.payload.action === 'edited' || context.payload.action === 'submitted') &&
      context.payload.review.state === 'approved'
    ) {
      try {
        const requiredReviews = await this.findQeUsers();
        if (requiredReviews.includes(context.payload.sender.login)) {
          this.app.log.debug(logFields, `Creating successfull check (PR ${context.payload.pull_request.number})`);

          const response = await context.github.checks.create(
            context.repo({
              name: PrChecker.CHECK_NAME,
              head_sha: context.payload.pull_request.head.sha,
              status: 'completed' as 'completed',
              conclusion: 'success' as 'success',
              completed_at: moment().toISOString(),
            }),
          );

          checkResponseStatus(
            response,
            201,
            `Failed to create green check_run after approval of PR#${
              context.payload.pull_request.number
            }. A normal check_run will be queued.`,
            logFields,
          );
          return;
        }
      } finally {
        // Nothing to do.
      }
    }

    // ...else, enqueue a check run.
    this.app.log.debug(logFields, `Queuing new PR checks (PR ${context.payload.pull_request.number})`);
    this.createCheckRun(context.github, context.repo({ head_sha: context.payload.pull_request.head.sha }));
  };

  private createCheckRun = async (api: GitHubAPI, commit: { owner: string; repo: string; head_sha: string }) => {
    try {
      const response = await api.checks.create({
        status: 'queued' as 'queued',
        name: PrChecker.CHECK_NAME,
        ...commit,
      });
      checkResponseStatus(response, 201, `Failed to create check run`, {
        head_sha: commit.head_sha,
        ...PrChecker.LOG_FIELDS,
      });
    } finally {
      // Well... this could be "critical". No checks will happen if this fails.
    }
  };

  private doChecks = async (context: Context<WebhookPayloadCheckRun>): Promise<void> => {
    const logFields = { sha: context.payload.check_run.head_sha, ...PrChecker.LOG_FIELDS };

    // Proceed only if the app owns the check and is a check of the current behavior
    if (!this.isOwnedCheckRun(context.payload.check_run)) {
      return;
    }

    // Proceed only if check run is queued
    if (context.payload.check_run.status !== 'queued') {
      this.app.log.debug(logFields, 'Created check run is not "queued". Not running checks.');
      return;
    }

    try {
      const pull_requests = await getOrQueryPrsForCommit(
        context.github,
        context.repo(),
        context.payload.check_run.head_sha,
        context.payload.check_run.pull_requests,
      );

      // PRs opened by bot should always pass
      for (const pr of pull_requests) {
        const fullPr = await context.github.pulls.get(
          context.repo({
            number: pr.number,
          }),
        );
        checkResponseWith(fullPr, { logFields: { phase: 'check bot', ...logFields } });
        if (fullPr.data.user.login === process.env.KIALI_BOT_USER) {
          this.app.log.info(PrChecker.LOG_FIELDS, `Not doing checks on PR because it is owned by the bot user.`);
          return this.markBotPrAsOk(context);
        }
      }

      // Mark check as in-progress
      const inProgressUpdate = context.repo({
        check_run_id: context.payload.check_run.id,
        status: 'in_progress' as 'in_progress',
        started_at: moment().toISOString(),
      });
      checkResponseWith(await context.github.checks.update(inProgressUpdate), {
        logFields: { phase: 'Mark in_progress', ...logFields },
      });

      // Resolve reviews status
      const qeUsers = await this.findQeUsers();

      const prReviews: ReviewStatuses = {};
      for await (const pr of pull_requests) {
        const listReviewsParams = context.repo({
          pull_number: pr.number,
        });
        const getReviewsParams = context.github.pulls.listReviews.endpoint.merge(listReviewsParams);
        for await (const reviews of context.github.paginate.iterator(getReviewsParams)) {
          checkResponseWith(reviews, { logFields: { phase: 'resolve reviews', ...logFields } });
          reviews.data.forEach((val: PullsListReviewsResponseItem) => {
            prReviews[val.user.login] = val.state;
          });
        }
      }

      // Check if PR is approved by QE
      let conclusion = 'failure' as 'failure' | 'success';
      if (qeUsers.some(user => prReviews[user] && prReviews[user] === 'APPROVED')) {
        conclusion = 'success';
      }

      // At least one member from QE has approved. Mark check as OK.
      const inProgressFinish = context.repo({
        check_run_id: context.payload.check_run.id,
        status: 'completed' as 'completed',
        conclusion: conclusion,
        completed_at: moment().toISOString(),
      });
      checkResponseWith(await context.github.checks.update(inProgressFinish), {
        logFields: { phase: 'mark complete', ...logFields },
      });
    } catch {
      this.app.log.error(logFields, 'Error performing check_run');
    }
  };

  private markBotPrAsOk = async (context: Context<WebhookPayloadCheckRun>): Promise<void> => {
    const inProgressFinish = context.repo({
      check_run_id: context.payload.check_run.id,
      status: 'completed' as 'completed',
      conclusion: 'success' as 'success',
      completed_at: moment().toISOString(),
    });
    checkResponseWith(await context.github.checks.update(inProgressFinish), {
      logFields: { sha: context.payload.check_run.head_sha, ...PrChecker.LOG_FIELDS },
    });
  };

  private findQeUsers = async () => {
    return ['edgarHzg', 'israel-hdez'];
  };

  private isOwnedCheckRun = (checkRun: WebhookPayloadCheckRunCheckRun): boolean => {
    if (checkRun.app.id !== Number(process.env.APP_ID) && checkRun.name !== PrChecker.CHECK_NAME) {
      this.app.log.trace(PrChecker.LOG_FIELDS, `Check run ${checkRun.id} not owned by this behavior`);
      return false;
    }

    return true;
  };
}
