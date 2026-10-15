import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { ProjectsService } from '../../dist/project-service/projects.service.js';

test('project identifiers are validated before any database query', async () => {
  let queried = false;
  const projects = new ProjectsService({
    select: async () => {
      queried = true;
      return [];
    },
  });
  await assert.rejects(projects.get('user_test', 'not-a-uuid'), BadRequestException);
  assert.equal(queried, false);
});