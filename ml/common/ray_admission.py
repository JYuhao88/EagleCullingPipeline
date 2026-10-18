"""Shared project admission: two ordinary jobs plus one CPU-only teacher job."""
import math
import re


def job_kind(job):
    metadata = job.get('metadata') if isinstance(job.get('metadata'), dict) else {}
    resources = job.get('entrypoint_resources')
    if isinstance(resources, dict) and resources.get('GPU'):
        return 'gpu'
    count = job.get('entrypoint_num_gpus', metadata.get('ecp_requested_gpus'))
    try:
        count = float(count)
    except (TypeError, ValueError):
        return 'gpu'
    if not math.isfinite(count) or count != 0:
        return 'gpu'
    return 'teacher' if metadata.get('ecp_job_kind') == 'teacher' else 'cpu'


def admission(active, line, candidate):
    if candidate not in ('gpu', 'teacher'):
        raise ValueError('unsupported project job kind')
    project = [job for job in active if re.match(r'^w(?:[1-9]|[12][0-9]|3[0-9])-',
                                                str(job.get('submission_id', '')))]
    prefix = 'w36-' if line == 'w36-vlm-critique' else line + '-'
    own = [job_kind(job) for job in project if str(job.get('submission_id', '')).startswith(prefix)]
    if candidate in own or candidate == 'teacher' and 'cpu' in own:
        raise RuntimeError('an own ' + candidate + ' job is already active')
    kinds = [job_kind(job) for job in project]
    gpu = kinds.count('gpu')
    ordinary = sum(kind != 'teacher' for kind in kinds)
    return len(project) < 3 and gpu + (candidate == 'gpu') <= 2 and ordinary + (candidate != 'teacher') <= 2
