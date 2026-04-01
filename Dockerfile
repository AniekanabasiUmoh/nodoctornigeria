FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml README.md /app/
COPY nstg_ai /app/nstg_ai
COPY sample_data /app/sample_data
COPY nigeria-clinical-guidelines-dataset-main/processed_json /app/nigeria-clinical-guidelines-dataset-main/processed_json

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "nstg_ai.api:app", "--host", "0.0.0.0", "--port", "8000"]
